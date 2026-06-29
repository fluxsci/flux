export {};

interface FileFilter {
  name: string;
  extensions: string[];
}

declare global {
  interface Window {
    fig: {
      openFiles(filters?: FileFilter[]): Promise<string[] | null>;
      openDirectory(title?: string): Promise<string | null>;
      save(defaultPath?: string, filters?: FileFilter[]): Promise<string | null>;
      readFile(path: string): Promise<ArrayBuffer>;
      writeFile(path: string, data: Uint8Array): Promise<void>;
      readText(path: string): Promise<string>;
      writeText(path: string, text: string): Promise<void>;
      mkdir(path: string): Promise<void>;
      exists(path: string): Promise<boolean>;
      exportPdf(svg: string, outPath: string, w: number, h: number): Promise<boolean>;
      printPdf(
        html: string,
        outPath: string,
        opts?: { margins?: Record<string, number> },
      ): Promise<boolean>;
      fetchDoi(doi: string): Promise<{ message?: unknown; error?: string }>;
      openExternal(url: string): Promise<void>;
      quartoAvailable(): Promise<{ installed: boolean; version?: string }>;
      quartoRender(
        root: string,
        to: string,
      ): Promise<{ ok: boolean; code?: number; log: string }>;
      paths(): Promise<{ home: string; userData: string; documents: string }>;
    };
  }
}
