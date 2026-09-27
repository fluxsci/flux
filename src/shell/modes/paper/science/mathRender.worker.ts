import katex from "katex";
import { safeMathRender } from "./safeMath";
self.onmessage = (event: MessageEvent<{ id: number; tex: string; display: boolean }>) => {
  const { id, tex, display } = event.data;
  self.postMessage({ id, html: safeMathRender(katex, tex, display) });
};
self.postMessage({ ready: true });
