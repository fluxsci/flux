export interface KnownProject {
  root: string;
  title: string;
  lastOpened?: string;
  lastConnected?: string;
}
export function recordProjectOpened(root: string, title: string): Promise<void>;
export function recordProjectConnected(root: string, title: string): Promise<void>;
export function listKnownProjects(): Promise<KnownProject[]>;
