/** Installed archive records contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openWarc } from "@okikio/opfs/archive/warc";
import { openMime } from "@okikio/opfs/archive/mime";
import { openMbox } from "@okikio/opfs/archive/mbox";
import { openArc } from "@okikio/opfs/archive/arc";
import { assertBytes } from "../../bytes.mjs";
import warcInput from "../../data/archive/warc.json" with { type: "json" };
import mimeInput from "../../data/archive/mime.json" with { type: "json" };
import mboxInput from "../../data/archive/mbox.json" with { type: "json" };
import arcInput from "../../data/archive/arc.json" with { type: "json" };

describe("packed archive records", () => {
  it("WARC stored blocks and digests", async () => {
    const warcFixture = warcInput;
    const warcArchive = await openWarc(
      createByteSource(Uint8Array.from(atob(warcFixture.base64), (byte) => byte.charCodeAt(0))),
    );
    assertBytes(
      (await warcArchive.read(1)).bytes,
      Uint8Array.from(atob(warcFixture.records[1].blockBase64), (byte) => byte.charCodeAt(0)),
    );
    if ((await warcArchive.verifyBlock(1, { subtle: globalThis.crypto.subtle })).integrity !== "stored-block-digest") {
      throw new Error("Packed WARC block proof failed");
    }
  });
  it("MIME decoded attachments", async () => {
    const mimeFixture = mimeInput;
    const mimeArchive = await openMime(
      createByteSource(Uint8Array.from(atob(mimeFixture.base64), (byte) => byte.charCodeAt(0))),
    );
    const mimeAttachment = mimeArchive.entries.find((entry) => entry.filenameStatus === "decoded");
    if (!mimeAttachment) throw new Error("Packed MIME attachment missing");
    assertBytes(
      (await mimeArchive.read(mimeAttachment.id)).bytes,
      Uint8Array.from(
        atob(mimeFixture.parts.find((part) => part.filename === mimeAttachment.filename).payloadBase64),
        (byte) => byte.charCodeAt(0),
      ),
    );
  });
  it("mboxrd message MIME composition", async () => {
    const mboxFixture = mboxInput;
    const mailbox = await openMbox(
      createByteSource(Uint8Array.from(atob(mboxFixture.base64), (byte) => byte.charCodeAt(0))),
      { dialect: "mboxrd" },
    );
    const message = await mailbox.openMessage(1, { trailing: "remove-one" });
    const messageMime = await openMime(message.source);
    assertBytes((await messageMime.read(0)).bytes, new Uint8Array([0, 1, 2, 3, 255]));
  });
  it("ARC stored blocks", async () => {
    const arcFixture = arcInput;
    const arc = await openArc(createByteSource(Uint8Array.from(atob(arcFixture.base64), (byte) => byte.charCodeAt(0))));
    const arcBlock = await arc.read(1);
    if (arcBlock.integrity !== "none" || !new TextDecoder().decode(arcBlock.bytes).startsWith("HTTP/1.1 200 OK")) {
      throw new Error("Packed ARC stored block changed");
    }
  });
});
