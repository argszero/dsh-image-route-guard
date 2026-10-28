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
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * Local copies of the two primitives this mount needs, deliberately not
 * imported: `@deepseek-ai/dsh-llm` is a real dependency of the harness, not of a
 * profile, so importing it makes the installed plugin unresolvable
 * (`ERR_MODULE_NOT_FOUND` — measured on the installed copy). Both are a few
 * lines, and `test/` pins them byte-for-byte against the runtime's own exports.
 */

/** Durable image reference, narrowed to the field the placeholder reads. */
interface ImageRef {
  readonly attachmentId: string
}

/** Stable text shown to a model that cannot accept one durable image reference. */
function textOnlyImageText(ref: ImageRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/** Whether this content carries an image block. */
function contentHasImage(content: readonly { type: string }[]): boolean {
  return content.some(block => block.type === 'image')
}

/**
 * Project request image content into deterministic text.
 * Untouched messages keep their identity, so a healthy request is not copied.
 */
function projectImagesForTextModel<T extends { content: readonly { type: string }[] }>(
  messages: readonly T[],
): readonly T[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    return {
      ...message,
      content: message.content.map(block => (block.type === 'image'
        ? { type: 'text', text: textOnlyImageText((block as unknown as { attachment: ImageRef }).attachment) }
        : block)),
    }
  })
}

export const name = 'image-route-guard'

/** The LLM runtime is the seam; nothing else is required. */
export const inject = ['llm']

/** One route an operator declares unable to carry an image block. */
export interface RouteRule {
  /** Provider (route) id exactly as registered, e.g. `agnes`. */
  provider: string
  /** Exact model id; omit to cover every model on this provider. */
  model?: string
}

/** Plugin configuration. */
export interface Config {
  /** Routes whose requests must carry text placeholders instead of image blocks. */
  routes?: RouteRule[]
  /** Diagnostics per mount; 0 silences them. */
  warnLimit?: number
}

export const Config: z<Config> = z.object({
  routes: z.array(z.object({
    provider: z.string().required(),
    model: z.string(),
  })).default([]),
  warnLimit: z.number().default(5),
})

/** Cordis keeps the raw service under this symbol; a `get()` view is a fresh object each read. */
const ORIGINAL = Symbol.for('cordis.original')

interface StreamOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly never[]
}

interface StreamHost {
  stream(options: StreamOptions): unknown
}

/** Keep only rules that can be matched; a malformed entry must not disable the mount. */
function normalize(routes: readonly RouteRule[] | undefined): readonly RouteRule[] {
  if (!Array.isArray(routes)) return []
  const kept: RouteRule[] = []
  for (const rule of routes) {
    if (rule === null || typeof rule !== 'object') continue
    if (typeof rule.provider !== 'string' || rule.provider === '') continue
    kept.push(typeof rule.model === 'string' && rule.model !== ''
      ? { provider: rule.provider, model: rule.model }
      : { provider: rule.provider })
  }
  return kept
}

/** Whether this exact call's route is declared image-incapable. */
function matches(routes: readonly RouteRule[], options: StreamOptions): boolean {
  return routes.some(rule => rule.provider === options.provider
    && (rule.model === undefined || rule.model === options.model))
}

/** Whether the request would put an image block on the wire. */
function carriesImage(options: StreamOptions): boolean {
  return Array.isArray(options.messages)
    && options.messages.some(message => contentHasImage((message as { content: never[] }).content))
}

export function apply(ctx: Context, config: Config = {}): void {
  const routes = normalize(config.routes)
  // Nothing declared: mount, do nothing, say nothing.
  if (routes.length === 0) return

  let warnings = 0
  const warnLimit = typeof config.warnLimit === 'number' && config.warnLimit >= 0 ? config.warnLimit : 5
  const report = (message: string): void => {
    if (warnings >= warnLimit) return
    warnings += 1
    ctx.logger.warn(`${name}: ${message}`)
  }

  const view = (ctx as unknown as { llm: Record<PropertyKey, unknown> }).llm
  const instance = (view[ORIGINAL] ?? view) as unknown as StreamHost
  const hadOwn = Object.hasOwn(instance, 'stream')
  const previous = instance.stream
  const reported = new Set<string>()

  const ours = function (this: unknown, options: StreamOptions): unknown {
    let next = options
    try {
      if (matches(routes, options) && carriesImage(options)) {
        next = { ...options, messages: projectImagesForTextModel(options.messages) } as StreamOptions
        const key = `${options.provider}/${options.model}`
        if (!reported.has(key)) {
          reported.add(key)
          report(`projecting image blocks to text on "${key}": the route is declared image-incapable`)
        }
      }
    } catch {
      // Fail-open: a request this mount cannot read is dispatched untouched.
    }
    return previous.call(this, next)
  }

  instance.stream = ours
  ctx.effect(() => () => {
    // Leave a wrapper someone else mounted on top of this one in place.
    if (instance.stream !== ours) return
    if (hadOwn) instance.stream = previous
    else delete (instance as { stream?: unknown }).stream
  })
}
