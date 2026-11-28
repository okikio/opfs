/** Azure: The independent XML reader preserves scalar content and rejects a different grammar. */
import { it } from "node:test";
import { expect } from "@std/expect";
import { latestBlocks } from "./fixture.ts";

it("reconstructs the same ordered block IDs across equivalent XML character-data spellings", () => {
  // XML 1.0 section 3.1 defines CDATA and character references as element content.
  // Keep opaque IDs exact: only formatting between elements is varied.
  // https://www.w3.org/TR/xml/#sec-starttags
  for (
    const body of [
      "<BlockList><Latest>AA==</Latest><Latest>AQ==</Latest></BlockList>",
      "<BlockList>\n  <Latest>AA==</Latest>\n  <Latest>AQ==</Latest>\n</BlockList>",
      "<BlockList><Latest><![CDATA[AA==]]></Latest><Latest>A&#81;==</Latest></BlockList>",
    ]
  ) expect(latestBlocks(body)).toEqual(["AA==", "AQ=="]);
  expect(() => latestBlocks("<BlockList><Wrapper><Latest>AA==</Latest></Wrapper></BlockList>"))
    .toThrow(SyntaxError);
});
