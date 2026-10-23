#!/usr/bin/env -S node --import tsx
// Bulk arrangement primitives use disposable SVG attributes; dense artwork and
// ordinary move/resize keep their compositor drives. Test ownership across
// cancellation, strategy switches, culling, and a same-ID remount.
import assert from "node:assert/strict";
import { transientSceneTransforms } from "../src/lib/interact/sceneTransforms";

function wrapper(authored?: string) {
  const attributes = new Map<string, string>(authored ? [["transform", authored]] : []);
  const style = { transform: "", willChange: "" };
  let animations = 0;
  const node = {
    style,
    hasAttribute: (key: string) => attributes.has(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
    animate: () => {
      animations++;
      return { pause() {}, cancel() { animations--; }, effect: { setKeyframes() {} } };
    },
  } as unknown as SVGGElement;
  return { node, style, attributes, get animations() { return animations; } };
}
let checks = 0;
function equal(actual: unknown, expected: unknown) { assert.deepEqual(actual, expected); checks++; }
const scene = transientSceneTransforms();
const a = wrapper(), b = wrapper();
const registration = scene.register(a.node, "a");
scene.register(b.node, "b");
const move = (direct: ReadonlySet<string> | null, transform = "translate3d(12px, -3px, 0)") =>
  scene.update(null, "", null, "", new Map([["a", transform], ["b", transform]]), direct);
move(new Set(["a"]));
equal(a.attributes.get("transform"), "translate(12 -3)");
equal(a.style.transform, "");
equal(a.animations, 0);
equal(b.animations, 1);
move(null);
equal(a.attributes.has("transform"), false);
equal(a.animations, 1);
equal(a.style.transform, "translate3d(12px, -3px, 0)");
move(new Set(["a"]));
equal(a.animations, 0);
scene.update(null, "", null, "");
equal(a.attributes.has("transform"), false);
equal(b.animations, 0);
equal([a.style.transform, b.style.transform], ["", ""]);
move(new Set(["a"]));
registration.destroy();
equal(a.attributes.has("transform"), false);
const authored = wrapper("rotate(15)");
const authoredRegistration = scene.register(authored.node, "a");
equal(authored.attributes.get("transform"), "rotate(15)");
equal(authored.style.transform, "translate3d(12px, -3px, 0)");
authoredRegistration.destroy();
equal(authored.attributes.get("transform"), "rotate(15)");
scene.update(null, "", null, "");
const remount = wrapper();
const stale = scene.register(remount.node, "a");
equal(remount.attributes.has("transform"), false);
move(new Set(["a"]));
const replacement = wrapper();
scene.register(replacement.node, "a");
equal(remount.attributes.has("transform"), false);
equal(replacement.attributes.get("transform"), "translate(12 -3)");
stale.destroy();
equal(replacement.attributes.get("transform"), "translate(12 -3)");
move(new Set(["a"]), "scale(2)");
equal(replacement.attributes.has("transform"), false);
equal(replacement.style.transform, "scale(2)");
scene.update(null, "", null, "");
equal(replacement.style.transform, "");
console.log(`${checks} scene transform ownership checks passed`);
