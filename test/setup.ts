import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView; the renderer calls it after render.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
