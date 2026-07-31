export interface FileEntry {
  path: string; // relative path from project root
  name: string;
  ext: string;
  size: number;
}

export interface DirEntry {
  path: string;
  name: string;
  children: (DirEntry | FileEntry)[];
}

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  notes: string[];
}

export interface FolderRole {
  path: string;
  role: string;
  fileCount: number;
  sampleFiles: string[];
}

export interface DependencyNode {
  /**
   * Cluster id used as the node's identity in edges and the diagram.
   * For normal folder clusters this is the top-level folder name (e.g. "routes").
   * For rolled-up cycles it is the cycle members joined by "+" with a trailing "↻".
   */
  id: string;
  /** First folder of the original paths that ended up in this cluster. */
  folder: string;
  /** Number of TS/JS files (or parts of files) that contributed to this cluster. */
  fileCount: number;
  /** True if this id represents a non-trivial SCC (rolled-up cycle). */
  cycle: boolean;
  /** Folder names inside the SCC when `cycle` is true. */
  cycleMembers?: string[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  /** Number of import statements collapsed into this single edge. */
  weight: number;
  /** True when `to` is the "(external)" pseudo-node (bare imports). */
  external: boolean;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  /** Aggregate info for bare imports (e.g. `from 'react'`), excluded from SCCs. */
  externals: { count: number; samples: string[] };
  parsedFileCount: number;
  skippedFileCount: number;
  /** Human-readable warnings (oversized files, partial scans, etc.). */
  warnings: string[];
}

export interface ProjectMap {
  root: string;
  stack: StackInfo;
  structure: FolderRole[];
  fileTree: DirEntry;
  totalFiles: number;
  dependencies: DependencyGraph;
}
