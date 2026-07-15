import { mount } from "svelte";
import "./tokens.css";
import "./app.css";
import App from "./App.svelte";

async function boot() {
  if (import.meta.env.DEV) {
    const mock = new URLSearchParams(location.search).get("mock");
    if (mock) {
      const { installMock } = await import("./lib/mock");
      installMock(mock);
    }
  }
  mount(App, { target: document.getElementById("app")! });
}

void boot();
