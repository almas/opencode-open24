import { describe, expect, it } from "vitest"
import { DEFAULTS, IDLE_TOKEN_DEFAULT, IDLE_TOKEN_LEGACY, hasIdleToken, readSettings } from "../src/index"

describe("hasIdleToken", () => {
  it("detects the default HTML-comment marker", () => {
    expect(hasIdleToken("done <!-- OPEN24-IDLE -->", IDLE_TOKEN_DEFAULT)).toBe(true)
    expect(hasIdleToken("作業を続けました", IDLE_TOKEN_DEFAULT)).toBe(false)
  })

  it("still detects the legacy token when the default is in use", () => {
    expect(hasIdleToken("done " + IDLE_TOKEN_LEGACY, IDLE_TOKEN_DEFAULT)).toBe(true)
  })

  it("does not let the legacy token pause a session with a custom token", () => {
    expect(hasIdleToken("done " + IDLE_TOKEN_LEGACY, "[[CUSTOM]]")).toBe(false)
    expect(hasIdleToken("done [[CUSTOM]]", "[[CUSTOM]]")).toBe(true)
  })
})

describe("readSettings defaults", () => {
  it("uses safe defaults for empty options", () => {
    const cfg = readSettings({})
    expect(cfg.enabled).toBe(true)
    // The whole point of the default: a plugin must never keep every session
    // running unless the user explicitly asked for it.
    expect(cfg.armByDefault).toBe(false)
    expect(cfg.armOnToolUse).toBe(true)
    expect(cfg.delaySeconds).toBe(20)
    expect(cfg.maxDelaySeconds).toBe(600)
    expect(cfg.shellTimeoutMs).toBe(86_400_000)
    expect(cfg.idleToken).toBe(IDLE_TOKEN_DEFAULT)
    expect(cfg.continuePrompt).toContain(IDLE_TOKEN_DEFAULT)
  })

  it("keeps the shipped fallback models when the option is absent or malformed", () => {
    expect(readSettings({}).fallbackModels).toEqual(DEFAULTS.fallbackModels)
    expect(readSettings({ fallbackModels: "not-a-list" }).fallbackModels).toEqual(DEFAULTS.fallbackModels)
  })

  it("keeps armByDefault opt-in: only the literal true enables it", () => {
    for (const raw of [undefined, null, "true", 1, {}]) {
      expect(readSettings({ armByDefault: raw }).armByDefault).toBe(false)
    }
    expect(readSettings({ armByDefault: true }).armByDefault).toBe(true)
  })
})

describe("readSettings numbers", () => {
  it("accepts numeric strings", () => {
    expect(readSettings({ delaySeconds: "5" }).delaySeconds).toBe(5)
  })

  it("falls back on garbage", () => {
    for (const raw of ["abc", NaN, Infinity, null, {}, []]) {
      expect(readSettings({ delaySeconds: raw }).delaySeconds).toBe(DEFAULTS.delaySeconds)
    }
  })

  it("enforces per-key minimums", () => {
    expect(readSettings({ delaySeconds: -1 }).delaySeconds).toBe(DEFAULTS.delaySeconds)
    expect(readSettings({ delaySeconds: 0 }).delaySeconds).toBe(0)
    expect(readSettings({ backoffFactor: 0.5 }).backoffFactor).toBe(DEFAULTS.backoffFactor)
    expect(readSettings({ backoffFactor: 1 }).backoffFactor).toBe(1)
    expect(readSettings({ maxDelaySeconds: 0 }).maxDelaySeconds).toBe(DEFAULTS.maxDelaySeconds)
  })
})

describe("readSettings fallbackModels", () => {
  it("keeps only entries with both ids", () => {
    const cfg = readSettings({
      fallbackModels: [
        { providerID: "opencode", modelID: "m1" },
        { providerID: "opencode" },
        { modelID: "m2" },
        null,
        3,
        "str",
      ],
    })
    expect(cfg.fallbackModels).toEqual([{ providerID: "opencode", modelID: "m1" }])
  })

  it("strips unknown fields from accepted entries", () => {
    const cfg = readSettings({
      fallbackModels: [{ providerID: "p", modelID: "m", apiKey: "secret", extra: 1 }],
    })
    expect(cfg.fallbackModels[0]).toEqual({ providerID: "p", modelID: "m" })
  })
})

describe("readSettings prompts", () => {
  it("passes through custom strings", () => {
    const cfg = readSettings({ continuePrompt: "続ける" + IDLE_TOKEN_DEFAULT, idleToken: "[[T]]" })
    expect(cfg.continuePrompt).toBe("続ける" + IDLE_TOKEN_DEFAULT)
    expect(cfg.idleToken).toBe("[[T]]")
  })

  it("ignores non-string prompt options", () => {
    const cfg = readSettings({ continuePrompt: 42, idleToken: {} })
    expect(cfg.continuePrompt).toBe(DEFAULTS.continuePrompt)
    expect(cfg.idleToken).toBe(DEFAULTS.idleToken)
  })
})
