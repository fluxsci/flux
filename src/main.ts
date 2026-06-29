import { mount } from "svelte";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./app.css";
import Shell from "./shell/Shell.svelte";

const app = mount(Shell, {
  target: document.getElementById("app")!,
  intro: true,
});

export default app;
