/** S3: The independent XML reader preserves scalar content and rejects a different grammar. */
import { it } from "node:test";
import { expect } from "@std/expect";
import { completedParts } from "./fixture.ts";

it("reads equal completion fields across XML formatting and character-data spellings", () => {
  // XML 1.0 section 3.1 treats character references and CDATA as scalar content.
  // https://www.w3.org/TR/xml/#sec-starttags
  for (
    const body of [
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part></CompleteMultipartUpload>",
      '<CompleteMultipartUpload>\n  <Part>\n    <PartNumber>1</PartNumber>\n    <ETag><![CDATA["a"]]></ETag>\n  </Part>\n</CompleteMultipartUpload>',
    ]
  ) expect(completedParts(body)).toEqual([{ PartNumber: "1", ETag: '"a"' }]);
  expect(() =>
    completedParts(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag><Value>a</Value></ETag></Part></CompleteMultipartUpload>",
    )
  )
    .toThrow(SyntaxError);
});
