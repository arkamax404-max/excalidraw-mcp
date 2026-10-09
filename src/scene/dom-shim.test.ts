import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installDomShim } from "./dom-shim.ts";

/**
 * Unit tests for the selector id-prefix compatibility fallback.
 *
 * mermaid 11 renders DOM ids prefixed by the render id (`probeER-entity-A-0`)
 * while `@excalidraw/mermaid-to-excalidraw` 2.2.2 looks them up unprefixed
 * (`[id="entity-A-0"]` in dist/parser/er.js, `[id='...']` in
 * dist/parser/flowchart.js). The shim retries an empty exact lookup as a
 * suffix match `[id$="-X"]` once. These tests pin the contract on a synthetic
 * document; the end-to-end proof lives in `mermaid.test.ts`.
 */

/** Loose structural type for the jsdom elements these tests inspect. */
interface ProbeElement {
  id: string;
  querySelector(selector: string): ProbeElement | null;
  querySelectorAll(selector: string): ArrayLike<ProbeElement>;
}

/** Synthetic SVG-ish document mirroring mermaid's rendered shapes. */
const PROBE_HTML = `
<div id="container">
  <svg>
    <g id="probeER-entity-A-0"><text>Entity A</text></g>
    <g id="probeER-entity-B-0"><text>Entity B</text></g>
    <path id="probeER-edge-1" data-edge="true"></path>
    <path id="probeER-edge-1-alt"></path>
    <g id="subgraph-exact"></g>
    <g id="probe-subgraph-exact"></g>
    <g id="other-render-entity-A-0"></g>
  </svg>
</div>
`;

function container(): ProbeElement {
  const dom = installDomShim({ html: `<!doctype html><html><body>${PROBE_HTML}</body></html>` });
  const element: ProbeElement | null = dom.window.document.getElementById("container");
  assert.ok(element, "probe container must exist");
  return element;
}

describe("dom shim id-prefix selector fallback", () => {
  it("finds a prefixed id through a double-quoted exact selector", () => {
    const found = container().querySelector('[id="entity-A-0"]');
    assert.ok(found, "suffixed fallback must find probeER-entity-A-0");
    assert.equal(found.id, "probeER-entity-A-0");
  });

  it("finds a prefixed id through a single-quoted exact selector", () => {
    const found = container().querySelector("[id='entity-B-0']");
    assert.ok(found, "suffixed fallback must find probeER-entity-B-0");
    assert.equal(found.id, "probeER-entity-B-0");
  });

  it("finds prefixed ids through querySelectorAll", () => {
    // The rewrite is a suffix match: both ids ending in `-entity-A-0` come
    // back, which is the ambiguity the fallback accepts (exact lookups win
    // when they exist).
    const found = container().querySelectorAll('[id="entity-A-0"]');
    assert.equal(found.length, 2);
  });

  it("an exact id match wins over a suffix match", () => {
    // Both `subgraph-exact` and `probe-subgraph-exact` exist; the exact
    // selector must return the true exact element, not the prefixed one.
    const found = container().querySelector('[id="subgraph-exact"]');
    assert.ok(found);
    assert.equal(found.id, "subgraph-exact");
  });

  it("preserves the surrounding selector when rewriting", () => {
    // `edge-1-alt` also ends in the suffix shape but lacks data-edge=true;
    // the rewrite must keep the extra attribute filter.
    const found = container().querySelector('path[id="edge-1"][data-edge="true"]');
    assert.ok(found);
    assert.equal(found.id, "probeER-edge-1");
  });

  it("leaves selectors without [id=…] untouched", () => {
    const element = container();
    // Real class/path selectors behave normally, including empty results.
    assert.equal(element.querySelector(".does-not-exist"), null);
    assert.equal(element.querySelectorAll("path").length, 2);
    assert.equal(element.querySelectorAll("text").length, 2);
    const direct = element.querySelectorAll("g");
    assert.equal(direct.length, 5);
  });

  it("returns the original empty result when the rewrite also finds nothing", () => {
    assert.equal(container().querySelector('[id="no-such-entity"]'), null);
    assert.equal(container().querySelectorAll('[id="no-such-entity"]').length, 0);
  });
});
