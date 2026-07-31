import * as fs from 'fs';
import * as path from 'path';
import { DirEntry, FileEntry, DependencyGraph, DependencyNode, DependencyEdge } from './types';

// File extensions we treat as TS/JS for the import-graph. Other languages are
// silently skipped - v1 is regex-only, so we only parse what we can read reliably.
const TS_JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Hard ceiling on bytes we'll read from a single file. Past this we skip the
// file (counted as skippedFileCount + one warning) to avoid reading megabytes
// of unrelated code into a regex pass.
const MAX_PARSE_BYTES = 200 * 1024;

// Caps on the LLM-facing summary. These keep the system prompt small enough to
// leave room for max_tokens=800 responses on openai/gpt-oss-120b.
const MAX_COMPACT_LINES = 30;
const MAX_COMPACT_CHARS = 2000;

// Cap on per-graph warnings to avoid flooding the chat with noise.
const MAX_WARNINGS = 20;

// Token-form identifiers for cycle-detection bookkeeping.
const EXTERNAL_ID = '(external)';
const ROOT_INDEX_ID = '<root>/index';

// Regexes. `g` flag so we can iterate. Three capture groups (one per
// alternation); the first non-undefined wins.
//
// Order matters: alt 2 (bare side-effect `import 'x'`) must come BEFORE alt 1
// (`import ... from 'x'`), because alt 1's optional `from` clause can match
// across newlines and consume `'side-effect';\nexport { x } from ` as the
// `from` clause of an earlier import, swallowing the real side-effect.
// Alt 3 handles `export ... from 'x'` and `export * from 'x'`.
const RE_STATIC = /import\s+['"]([^'"]+)['"]|import\s+(?:[\s\S]+?\s+from\s+)?['"]([^'"]+)['"]|export\s+\*?\s*(?:[\s\S]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const RE_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Candidate extensions when resolving a specifier that has no extension of its
// own. Try each in declaration order; order matters only for tests that assert
// on a specific match.
const RESOLUTION_CANDIDATES = [
  '',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '/index.mjs', '/index.cjs'
];

/**
 * Converts a path to forward-slash form. We split on BOTH `/` and `\` so this
 * is portable across platforms (path.sep is `/` on Linux, `\` on Windows, but
 * string literals in source code can contain either regardless of host).
 * Import specifiers in source code are always forward-slash; both sides of an
 * import lookup must be posix-normalized before comparison.
 */
export function posix(p: string): string {
  return p.split(/[\\\/]/).join('/');
}

/**
 * Maps a relative file path to a top-level folder cluster id.
 *
 * Rules:
 * - `src/routes/orders.ts` -> `routes` (strip a bare `src/` prefix).
 * - `src/index.ts`        -> `<root>/index` (don't collapse one-node clusters).
 * - `backend/server.ts`   -> `backend`.
 * - `./index.ts` (root)   -> `<root>/index`.
 */
export function clusterIdFor(relPath: string): string {
  const normalized = posix(relPath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return ROOT_INDEX_ID;
  const first = parts[0];
  // Strip the file extension from the last segment so cluster ids are
  // folder-shaped, not file-shaped: 'app.ts' -> 'app', 'src/routes/orders.ts' -> 'routes'.
  const stripExt = (s: string) => s.replace(/\.[^./]+$/, '');
  if (first === 'src' && parts.length > 1) {
    const second = parts[1];
    if (parts.length === 2 && /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(second)) {
      return ROOT_INDEX_ID;
    }
    return stripExt(second);
  }
  if (parts.length === 1 && /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(first)) {
    return ROOT_INDEX_ID;
  }
  return stripExt(first);
}

/**
 * Extracts static import / require specifiers from a file's source text.
 * Dynamic `import('foo')` is intentionally NOT extracted in v1.
 */
export function extractImports(content: string): string[] {
  const out: string[] = [];
  RE_STATIC.lastIndex = 0;
  RE_REQUIRE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_STATIC.exec(content)) !== null) {
    // First non-undefined capture group wins (RE_STATIC has three alternations,
    // each with its own capture group).
    const spec = m[1] || m[2] || m[3];
    if (spec) out.push(spec);
  }
  while ((m = RE_REQUIRE.exec(content)) !== null) out.push(m[1]);
  return out;
}

/**
 * Resolves a relative specifier to a known file in the tree, or null if it
 * points to a bare import (external) or to a file we don't have.
 */
export function resolveImport(
  fromFile: string,
  spec: string,
  byPath: Map<string, FileEntry>
): string | null {
  if (!spec.startsWith('.')) return null; // bare import → external
  const fromDir = posix(path.dirname(fromFile));
  const joined = posix(path.posix.normalize(path.posix.join(fromDir, spec)));
  for (const ext of RESOLUTION_CANDIDATES) {
    const candidate = joined + ext;
    if (byPath.has(candidate)) return candidate;
  }
  return null;
}

function readFileCapped(absPath: string, fileSize: number): string | null {
  if (fileSize > MAX_PARSE_BYTES) return null;
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Builds a posix-keyed map from the DirEntry tree for fast file lookups.
 * FileEntry.path from the scanner is already a relative path; we posix-fold
 * it so resolution against forward-slash specifiers works on Windows.
 */
function buildFileIndex(tree: DirEntry): Map<string, FileEntry> {
  const idx = new Map<string, FileEntry>();
  function walk(node: DirEntry | FileEntry) {
    if ('children' in node) {
      for (const c of node.children) walk(c);
    } else {
      idx.set(posix(node.path), node);
    }
  }
  walk(tree);
  return idx;
}

/**
 * Iterative Tarjan SCC. Returns a list of SCCs, each SCC a list of node ids.
 * Iterative (not recursive) to avoid blowing the JS stack on long chain
 * dependencies.
 */
function tarjanSccs(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let nextIndex = 0;

  function strongconnect(v: string) {
    const work: { v: string; it: Iterator<string> }[] = [];
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);
    work.push({ v, it: (adj.get(v) || [])[Symbol.iterator]() });

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const next = frame.it.next();
      if (next.done) {
        // Done with v's neighbors — finalize.
        const v = frame.v;
        if (lowlink.get(v) === index.get(v)) {
          const scc: string[] = [];
          let w: string | undefined;
          do {
            w = stack.pop();
            if (w === undefined) break;
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          sccs.push(scc);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(v)!));
        }
      } else {
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, nextIndex);
          lowlink.set(w, nextIndex);
          nextIndex++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, it: (adj.get(w) || [])[Symbol.iterator]() });
        } else if (onStack.has(w)) {
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v)!, index.get(w)!));
        }
      }
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) strongconnect(v);
  }
  return sccs;
}

interface RawEdge {
  from: string;
  to: string;
  external: boolean;
}

/**
 * Builds the cluster-level graph and collapses cycles. Returns the final
 * nodes/edges for the DependencyGraph. Iterative Tarjan SCC runs over only
 * the in-project cluster ids (excluding `(external)`).
 */
function buildClusterGraph(rawEdges: RawEdge[]): { nodes: DependencyNode[]; edges: DependencyEdge[] } {
  // Aggregate raw edges into a single edge per (from, to) pair.
  const edgeMap = new Map<string, { from: string; to: string; weight: number; external: boolean }>();
  for (const e of rawEdges) {
    const key = `${e.from}|${e.to}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += 1;
    } else {
      edgeMap.set(key, { from: e.from, to: e.to, weight: 1, external: e.external });
    }
  }

  // Build the cluster id set (in-project clusters only).
  const clusterIds = new Set<string>();
  for (const e of edgeMap.values()) {
    if (!e.external) {
      clusterIds.add(e.from);
      clusterIds.add(e.to);
    }
  }

  // Build adjacency for Tarjan (only in-project clusters). Self-loops are
  // included so a node that imports itself (e.g. `src/a/a.ts` imports `./a`)
  // is still detected as a cycle by the single-node+self-edge case below.
  const adj = new Map<string, string[]>();
  for (const id of clusterIds) adj.set(id, []);
  for (const e of edgeMap.values()) {
    if (e.external) continue;
    adj.get(e.from)!.push(e.to);
  }

  const sccs = tarjanSccs(Array.from(clusterIds), adj);

  // Identify non-trivial SCCs (size > 1, or size 1 with a self-loop).
  const nontrivialIds = new Set<string>();
  const idsToScc = new Map<string, string[]>();
  for (const scc of sccs) {
    if (scc.length > 1) {
      const cycleId = scc.slice().sort().join('+') + '↻';
      for (const id of scc) {
        idsToScc.set(id, scc);
        nontrivialIds.add(cycleId);
      }
    } else {
      const id = scc[0];
      const hasSelfLoop = (adj.get(id) || []).includes(id);
      if (hasSelfLoop) {
        const cycleId = id + '↻';
        idsToScc.set(id, scc);
        nontrivialIds.add(cycleId);
      }
    }
  }

  // Map each cluster id to its final node id (cycle collapse).
  const idMap = new Map<string, string>();
  for (const id of clusterIds) {
    const scc = idsToScc.get(id);
    if (scc && scc.length > 1) {
      idMap.set(id, scc.slice().sort().join('+') + '↻');
    } else if (scc && scc.length === 1 && (adj.get(id) || []).includes(id)) {
      idMap.set(id, id + '↻');
    } else {
      idMap.set(id, id);
    }
  }

  // Build collapsed edges.
  const collapsedMap = new Map<string, { from: string; to: string; weight: number; external: boolean }>();
  for (const e of edgeMap.values()) {
    const newFrom = e.external ? e.from : idMap.get(e.from)!;
    const newTo = e.external ? e.to : idMap.get(e.to)!;
    // Drop self-loops that arose from collapsing (those are now implicit).
    if (newFrom === newTo) continue;
    const key = `${newFrom}|${newTo}`;
    const existing = collapsedMap.get(key);
    if (existing) {
      existing.weight += e.weight;
    } else {
      collapsedMap.set(key, { from: newFrom, to: newTo, weight: e.weight, external: e.external });
    }
  }

  // Build nodes from final ids.
  const nodeFolder = new Map<string, string>();
  const nodeFileCount = new Map<string, number>();
  for (const id of clusterIds) {
    const finalId = idMap.get(id)!;
    if (nodeFolder.has(finalId)) continue;
    if (finalId.endsWith('↻') && finalId.includes('+')) {
      // Multi-member cycle: folder = first member alphabetically.
      const members = finalId.slice(0, -1).split('+');
      nodeFolder.set(finalId, members[0]);
    } else {
      nodeFolder.set(finalId, finalId.replace(/↻$/, ''));
    }
    nodeFileCount.set(finalId, 0);
  }
  // Count files per final node id (we approximate fileCount from cluster membership).
  // We don't have raw file->cluster info here, so default to 0; the buildDependencyGraph
  // wrapper fills this in after the fact.
  const nodes: DependencyNode[] = Array.from(nodeFolder.entries()).map(([id, folder]) => {
    const cycle = id.endsWith('↻');
    const node: DependencyNode = {
      id,
      folder,
      fileCount: nodeFileCount.get(id) || 0,
      cycle
    };
    if (cycle && id.includes('+')) {
      node.cycleMembers = id.slice(0, -1).split('+');
    } else if (cycle) {
      node.cycleMembers = [id.slice(0, -1)];
    }
    return node;
  });

  const edges: DependencyEdge[] = Array.from(collapsedMap.values()).map(e => ({
    from: e.from,
    to: e.to,
    weight: e.weight,
    external: e.external
  }));

  return { nodes, edges };
}

/**
 * Builds the dependency graph from a scanned DirEntry tree.
 *
 * Reuses the existing tree (no re-walk) so scanner's symlink/MAX_FILES/IGNORE_DIRS
 * policies apply uniformly. Reads each TS/JS file up to MAX_PARSE_BYTES, extracts
 * imports with a regex, resolves relative specifiers, aggregates by top-level
 * folder cluster, and rolls up cycles.
 */
export function buildDependencyGraph(rootPath: string, tree: DirEntry): DependencyGraph {
  const byPath = buildFileIndex(tree);
  const warnings: string[] = [];

  const parsedFiles: FileEntry[] = [];
  const skippedFiles: FileEntry[] = [];
  for (const file of byPath.values()) {
    if (!TS_JS_EXTS.has(file.ext.toLowerCase())) continue;
    parsedFiles.push(file);
  }

  // Per-cluster file count bookkeeping.
  const clusterFileCount = new Map<string, number>();
  const rawEdges: RawEdge[] = [];
  const externalSamples = new Set<string>();
  let externalCount = 0;

  for (const file of parsedFiles) {
    const absPath = path.join(rootPath, file.path);
    const content = readFileCapped(absPath, file.size);
    if (content === null) {
      skippedFiles.push(file);
      if (warnings.length < MAX_WARNINGS) {
        warnings.push(`skipped: ${posix(file.path)} (${file.size} bytes > ${MAX_PARSE_BYTES} cap or unreadable)`);
      }
      continue;
    }

    const clusterId = clusterIdFor(file.path);
    clusterFileCount.set(clusterId, (clusterFileCount.get(clusterId) || 0) + 1);

    const imports = extractImports(content);
    for (const spec of imports) {
      const resolved = resolveImport(file.path, spec, byPath);
      if (resolved === null) {
        // Either bare import (external) or relative to a file we don't have.
        if (!spec.startsWith('.')) {
          externalCount += 1;
          if (externalSamples.size < 5) externalSamples.add(spec);
          rawEdges.push({ from: clusterId, to: EXTERNAL_ID, external: true });
        }
        // Unresolved relative imports are silently dropped - they don't add
        // useful information to the graph and would otherwise pollute it.
      } else {
        const targetCluster = clusterIdFor(resolved);
        if (targetCluster === clusterId) {
          // Same-cluster imports: still emit an edge so the LLM sees the
          // cohesion, but cycle handling will fold self-loops later.
          rawEdges.push({ from: clusterId, to: targetCluster, external: false });
        } else {
          rawEdges.push({ from: clusterId, to: targetCluster, external: false });
        }
      }
    }
  }

  const { nodes, edges } = buildClusterGraph(rawEdges);

  // Fill in fileCount on nodes now that we know it.
  for (const node of nodes) {
    if (node.cycle && node.cycleMembers) {
      let total = 0;
      for (const m of node.cycleMembers) total += clusterFileCount.get(m) || 0;
      node.fileCount = total;
    } else {
      node.fileCount = clusterFileCount.get(node.id) || 0;
    }
  }

  // Sort edges by weight desc for deterministic output.
  edges.sort((a, b) => b.weight - a.weight);

  return {
    nodes,
    edges,
    externals: { count: externalCount, samples: Array.from(externalSamples) },
    parsedFileCount: parsedFiles.length - skippedFiles.length,
    skippedFileCount: skippedFiles.length,
    warnings
  };
}

/**
 * Renders a compact, human-readable summary of the graph for the LLM system
 * prompt. Output is bounded by MAX_COMPACT_LINES and MAX_COMPACT_CHARS.
 */
export function buildCompactText(graph: DependencyGraph): string {
  const lines: string[] = [];

  const edges = graph.edges.slice(0, MAX_COMPACT_LINES);
  for (const e of edges) {
    const suffix = e.external ? '' : '';
    const word = e.weight === 1 ? 'import' : 'imports';
    lines.push(`- ${e.from} → ${e.to} (${e.weight} ${word})${suffix}`);
  }
  if (graph.edges.length > MAX_COMPACT_LINES) {
    lines.push(`... (${graph.edges.length - MAX_COMPACT_LINES} more edges elided)`);
  }

  const cycles = graph.nodes.filter(n => n.cycle);
  for (const c of cycles) {
    const members = (c.cycleMembers || [c.id]).join(' ↔ ');
    lines.push(`- ⚠ Circular: ${members}`);
  }

  if (graph.externals.count > 0) {
    const sampleList = graph.externals.samples.join(', ') || '(none)';
    lines.push(`- (external): ${graph.externals.count} bare imports (e.g. ${sampleList})`);
  }

  if (graph.parsedFileCount === 0) {
    lines.push('(no TS/JS files were parsed)');
  }

  let text = lines.join('\n');
  if (text.length > MAX_COMPACT_CHARS) {
    text = text.slice(0, MAX_COMPACT_CHARS) + '…';
  }
  return text;
}

/**
 * Renders the graph as a Mermaid `flowchart LR` string. Node ids are sanitized
 * to `[a-zA-Z0-9_]+`; labels are double-quoted with internal quotes/backslashes
 * escaped.
 */
export function toMermaid(graph: DependencyGraph): string {
  const lines: string[] = ['flowchart LR'];

  function safeId(s: string): string {
    return s.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function sanitizeLabel(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  if (graph.nodes.length === 0) {
    lines.push('  empty["No TS/JS files found in this workspace"]');
    return lines.join('\n');
  }

  // Emit declarations first so Mermaid can resolve edges to forward refs.
  for (const n of graph.nodes) {
    const label = sanitizeLabel(n.id);
    lines.push(`  ${safeId(n.id)}["${label}"]`);
  }
  for (const e of graph.edges) {
    if (e.weight === 0) continue;
    const label = e.external ? '' : `|${e.weight}|`;
    lines.push(`  ${safeId(e.from)} -->${label} ${safeId(e.to)}`);
  }
  return lines.join('\n');
}
