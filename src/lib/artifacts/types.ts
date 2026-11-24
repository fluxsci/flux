// Paper's artifacts: HTML pages an agent wrote for the reader, listed from the project's
// artifacts/ folder and one linked folder. These are the shapes the bridge returns
// (electron/artifactServe.cjs `describeRoot`; the dev fixture gets the same from its dev route).

export interface ArtifactPage {
  /** Path below the root, forward slashes: "pop_explorer/io.html". */
  rel: string;
  name: string;
  /** What the frame loads. Its origin is the root's own, never the app's (the dev fixture aside). */
  url: string;
  /** The file on disk. */
  path: string;
}

export interface Artifact {
  /** `<root id>:<rel>`: stable for a folder on this machine, across sessions. */
  id: string;
  rootId: string;
  /** The artifact's folder below the root ("" when the root itself is one), or its file. */
  rel: string;
  /** A folder with an index page and whatever it loads, or one self-contained page. */
  kind: "folder" | "file";
  /** The folder it is listed under ("" at the top of the root). */
  group: string;
  title: string;
  mtimeMs: number;
  /** The folder on disk: the artifact's own for "folder", the one holding it for "file". */
  dir: string;
  entry: string;
  pages: ArtifactPage[];
  /** How an agent is told where the entry page is: project-relative inside the project, absolute outside it. */
  ref: string;
}

export interface ArtifactRoot {
  /** "" for a linked folder that is not there. */
  id: string;
  dir: string;
  linked: boolean;
  label: string;
  missing: boolean;
  /** The folder was too large to read in full. */
  truncated: boolean;
  /** Pages of this folder may reach the network (the reader allowed it). */
  network: boolean;
  /** Changes on disk reload the open page. False for a folder too large to watch. */
  watching: boolean;
  artifacts: Artifact[];
}

export interface ArtifactListing {
  roots: ArtifactRoot[];
  /** The folder linked to this project in Settings, or null. */
  linkedDir: string | null;
  /** <project>/artifacts, whether or not it exists. */
  projectDir: string;
}

export interface ArtifactsChanged {
  /** Files a page of these roots had loaded, changed on disk. */
  paths: string[];
  /** Pages came, went or were rewritten: the list may be different. */
  structure: boolean;
}
