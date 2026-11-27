# Check object operations and retained data

Verify the operations the application uses with its actual storage client. A provider's compatibility label does not establish every request header, signature, streaming or retention behavior.

Exercise the required upload, authorized download, missing-object response, deletion and privacy behavior in the intended environment. Inspect object keys, content type, metadata, request signing, redirects and bounded response handling where they affect the consumer.

Check how independent applications or tenants choose keys. Separate credentials do not prevent collisions or cross-access unless the key scheme and enforced policy supply that isolation. Bind the application's namespace and authorization to the required data scope.

Identify whether deletion removes the current object, a marker, retained versions or all data under the relevant policy. Retention, recovery and temporary cleanup have different promises. Verify remaining versions and owned resources before claiming retirement is complete.

Preserve failed responses and useful non-secret request metadata. Follow the actual retry and partial-upload contract, including cancellation and abandoned resources. A passing direct storage probe supports that client operation; repeat the relevant application flow before claiming the user problem is resolved.
