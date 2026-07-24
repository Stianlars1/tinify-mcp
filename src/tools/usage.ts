import { z } from "zod";
import {
  textResult,
  toErrorResult,
  type TextResult,
  type TinifyLikeClient,
} from "./shared.js";

export const getUsageTool = {
  name: "get_usage",
  config: {
    title: "Get account usage",
    description:
      "Show the Tinify.dev account's current billing-period usage: plan, period, operations included, used, and remaining.",
    inputSchema: {},
    outputSchema: {
      plan: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      included: z.number(),
      reserved: z.number(),
      used: z.number(),
      remaining: z.number(),
      request_id: z.string(),
    },
    annotations: {
      title: "Get usage",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  makeHandler(client: TinifyLikeClient) {
    return async (): Promise<TextResult> => {
      try {
        const result = await client.usage();
        const u = result.data;
        return textResult(
          `Plan ${u.plan}: ${u.used} of ${u.included} operations used ` +
            `(${u.remaining} remaining) in the period ${u.period_start} → ${u.period_end}.`,
          {
            plan: u.plan,
            period_start: u.period_start,
            period_end: u.period_end,
            included: u.included,
            reserved: u.reserved,
            used: u.used,
            remaining: u.remaining,
            request_id: result.requestId,
          },
        );
      } catch (error) {
        return toErrorResult(error);
      }
    };
  },
};
