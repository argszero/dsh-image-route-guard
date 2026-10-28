/**
 * Keep an image block off a route that cannot carry one.
 *
 * ## The gap
 *
 * `LlmRuntime` assembles every outgoing request in one place, and it projects
 * image blocks into text exactly once — at
 * `packages/llm/llm/src/index.ts:1105-1109`, under this condition:
 *
 *     if (modelInfo.inputModalities !== undefined
 *       && !modelInfo.inputModalities.includes('image')
 *       && projectedMessages.some(message => contentHasImage(message.content))) {
 *       projectedMessages = projectImagesForTextModel(projectedMessages)
 *     }
 *
 * The condition reads the **model's declared modality** and nothing else. It
 * never asks whether the *route* — the provider plus the protocol it is
 * configured with — has any legal wire shape for an image block. So a model
 * that truthfully declares `['text', 'image']`, served over a protocol that
 * cannot carry the block, dispatches it untouched:
 * `llm-pi-ai/src/context.ts` `toPiContextWithImages` converts it and sends it.
 *
 * That is #11311. A vision model on a pi-ai `openai-responses` route produced a
 * tool result carrying one local WebP image; the block went out, the gateway
 * answered `400 ... input: data did not match any variant of untagged enum
 * ResponseInput`, and because the block lives in durable history, **every later
 * request replayed it** — including pure-text turns — leaving the session
 * permanently unusable.
 *
 * ## What this plugin does, and what it does not
 *
 * It projects image blocks to the harness's own text placeholder
 * (`textOnlyImageText`, `llm/src/content.ts:76`) before dispatch, on the routes
 * an operator declares image-incapable. `projectImagesForTextModel` is used
 * unchanged, so the placeholder is byte-identical to the one core emits for a
 * text-only model.
 *
 * It does **not** detect which protocols carry images, and it does not touch
 * `inputModalities`: a provider's Chat Completions route keeps sending the
 * image even when its Responses route must not. Detection belongs upstream in
 * the condition above; this is the deployment-side narrowing until then.
 *
 * Fail-open and silent: an unconfigured or unreadable call is dispatched with
 * the caller's own options object, by identity, not a copy.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "image-route-guard";
/** The LLM runtime is the seam; nothing else is required. */
export declare const inject: string[];
/** One route an operator declares unable to carry an image block. */
export interface RouteRule {
    /** Provider (route) id exactly as registered, e.g. `agnes`. */
    provider: string;
    /** Exact model id; omit to cover every model on this provider. */
    model?: string;
}
/** Plugin configuration. */
export interface Config {
    /** Routes whose requests must carry text placeholders instead of image blocks. */
    routes?: RouteRule[];
    /** Diagnostics per mount; 0 silences them. */
    warnLimit?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): void;
