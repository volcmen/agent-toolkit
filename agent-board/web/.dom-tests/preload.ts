import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register({
  url: "http://agent-board.test/",
  width: 1440,
  height: 900,
})

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
})

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ObserverStub,
})
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  value: ObserverStub,
})
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
})
Object.defineProperty(window.Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
})
