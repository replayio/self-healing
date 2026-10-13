import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingPage } from "../src/pages/Landing";

test("landing offers the supported setup route and preserves API navigation", () => {
  const html = renderToStaticMarkup(createElement(LandingPage));
  assert.match(html, /href="\/setup"[^>]*>Set up in Obvious<\/a>/);
  assert.match(html, /href="\/api"[^>]*>View API reference<\/a>/);
  assert.match(html, /FullStory\/Subtext/);
  assert.match(html, /Your team controls review and merging/);
});

test("landing groups partner identities and makes setup dependencies visible", () => {
  const html = renderToStaticMarkup(createElement(LandingPage));
  assert.equal((html.match(/class="partner-pair"/g) ?? []).length, 3);
  assert.match(html, /aria-labelledby="before-you-start"/);
  assert.match(html, /repository and deployment configuration/);
  assert.match(html, /active factory loop/);
  assert.match(html, /usable PR preview/);
});
