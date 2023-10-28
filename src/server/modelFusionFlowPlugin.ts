import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { withRun } from "modelfusion";
import type { AssetStorage } from "./AssetStorage.js";
import { Flow } from "./Flow.ts.js";
import { FlowRun } from "./FlowRun.js";
import { Logger } from "./Logger.js";
import { PathProvider } from "./PathProvider.js";
import { z } from "zod";

export interface ModelFusionFlowPluginOptions {
  flow: Flow<any, any>;
  path: string;
  assetStorage: AssetStorage;
  logger: Logger;
}

export const modelFusionFlowPlugin: FastifyPluginAsync<
  ModelFusionFlowPluginOptions
> = async (
  fastify: FastifyInstance,
  { flow, path, assetStorage, logger }: ModelFusionFlowPluginOptions
) => {
  type EVENT = z.infer<typeof flow.eventSchema>;

  const paths = new PathProvider(path);
  const runs: Record<string, FlowRun<EVENT>> = {};

  fastify.post(paths.basePath, async (request) => {
    const run = new FlowRun<EVENT>({
      paths,
      assetStorage,
      logger,
    });

    runs[run.runId] = run;

    // body the request body is json, parse and validate it:
    const input = flow.inputSchema.parse(request.body);

    // start longer-running process (no await):
    withRun(run, async () => {
      flow
        .process({
          input,
          run,
        })
        .catch((error) => {
          logger.logError({
            run,
            message: "Failed to process flow",
            error,
          });
        })
        .finally(async () => {
          run.finish();
        });
    });

    return {
      id: run.runId,
      path: paths.getEventsPath(run.runId),
    };
  });

  fastify.get(paths.getAssetPathTemplate(), async (request, reply) => {
    const runId = (request.params as any).runId;
    const assetName = (request.params as any).assetName;

    const asset = await assetStorage.readAsset({
      run: runs[runId],
      assetName,
    });

    if (asset == null) {
      logger.logError({
        run: runs[runId],
        message: `Asset ${assetName} not found`,
        error: new Error(`Asset ${assetName} not found`),
      });
      reply.status(404);
      return { error: `Asset ${assetName} not found` };
    }

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Content-Length": asset.data.length,
      "Content-Type": asset.contentType,
      "Cache-Control": "no-cache",
    };

    reply.raw.writeHead(200, headers);

    reply.raw.write(asset.data);
    reply.raw.end();
  });

  fastify.get(paths.getEventsPathTemplate(), async (request, reply) => {
    const runId = (request.params as any).runId;

    const eventQueue = runs[runId]?.eventQueue;

    if (!eventQueue) {
      return {
        error: `No event queue found for run ID ${runId}`,
      };
    }

    const headers = {
      "Access-Control-Allow-Origin": "*",

      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
      "Content-Encoding": "none",
    };

    reply.raw.writeHead(200, headers);

    const textEncoder = new TextEncoder();
    for await (const event of eventQueue) {
      if (reply.raw.destroyed) {
        // client disconnected
        break;
      }

      const text = textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);

      reply.raw.write(text);
    }

    reply.raw.end();
  });
};
