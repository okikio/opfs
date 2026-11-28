export interface ServerOptions {
  readonly port: number;
  readonly signal?: AbortSignal;
}

export function createHandler(): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health/ready") {
      return Response.json({ status: "ready" });
    }
    return new Response("Not Found", { status: 404 });
  };
}

export function startServer(options: ServerOptions): Deno.HttpServer {
  return Deno.serve(
    { port: options.port, signal: options.signal },
    createHandler(),
  );
}

if (import.meta.main) {
  const controller = new AbortController();
  Deno.addSignalListener("SIGINT", () => controller.abort());
  startServer({ port: 8000, signal: controller.signal });
}
