import { describe, expect, it } from "vitest";
import {
  canonicalizeListingUrl,
  parseAreaM2,
  parsePricePln,
  parseRoomCount,
  stableExternalId,
} from "./normalization";

describe("Polish listing normalization", () => {
  it.each([
    ["399 000 zł", 399000],
    ["399 000 PLN", 399000],
    ["399.000 zł", 399000],
    ["1.100.000 zł", 1100000],
    ["około 400 000 zł", null],
    ["7 290 zł/m²", null],
  ])("parses price %s", (input, expected) => {
    expect(parsePricePln(input)).toBe(expected);
  });

  it.each([
    ["45,6 m²", 45.6],
    ["45.60 m2", 45.6],
    ["metry do uzupełnienia", null],
  ])("parses area %s", (input, expected) => {
    expect(parseAreaM2(input)).toBe(expected);
  });

  it.each([["1 pokój", 1], ["2 pokoje", 2], ["3 rooms", 3], ["salon i sypialnia", null]])(
    "parses room count %s",
    (input, expected) => expect(parseRoomCount(input)).toBe(expected),
  );

  it("canonicalizes recognized listing URLs and drops only tracking parameters", () => {
    expect(canonicalizeListingUrl("otodom", "http://www.otodom.pl/oferta/test?utm_source=x&offer=123#photo")).toBe(
      "https://otodom.pl/oferta/test?offer=123",
    );
    expect(() => canonicalizeListingUrl("manual", "http://127.0.0.1:8080/private")).toThrow();
    expect(() => canonicalizeListingUrl("domy", "https://not-domy.pl/oferta")).toThrow();
    expect(() => canonicalizeListingUrl("domy", "javascript:alert(1)")).toThrow();
  });

  it("uses stable portal ids or a deterministic URL hash", () => {
    const url = "https://domy.pl/mieszkanie/slaskie-katowice-test-sba/dol1234567890";
    expect(stableExternalId("domy", url)).toBe("dol1234567890");
    expect(stableExternalId("manual", "https://domy.pl/mieszkanie/test")).toBe(
      stableExternalId("manual", "https://domy.pl/mieszkanie/test"),
    );
  });
});
