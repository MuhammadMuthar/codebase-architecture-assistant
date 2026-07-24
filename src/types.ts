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

export interface ProjectMap {
  root: string;
  stack: StackInfo;
  structure: FolderRole[];
  fileTree: DirEntry;
  totalFiles: number;
}
