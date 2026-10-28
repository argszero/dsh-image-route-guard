import { contentHasImage, projectImagesForTextModel } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
export const name = 'image-route-guard';
/** The LLM runtime is the seam; nothing else is required. */
export const inject = ['llm'];
export const Config = z.object({
    routes: z.array(z.object({
        provider: z.string().required(),
        model: z.string(),
    })).default([]),
    warnLimit: z.number().default(5),
});
/** Cordis keeps the raw service under this symbol; a `get()` view is a fresh object each read. */
const ORIGINAL = Symbol.for('cordis.original');
/** Keep only rules that can be matched; a malformed entry must not disable the mount. */
function normalize(routes) {
    if (!Array.isArray(routes))
        return [];
    const kept = [];
    for (const rule of routes) {
        if (rule === null || typeof rule !== 'object')
            continue;
        if (typeof rule.provider !== 'string' || rule.provider === '')
            continue;
        kept.push(typeof rule.model === 'string' && rule.model !== ''
            ? { provider: rule.provider, model: rule.model }
            : { provider: rule.provider });
    }
    return kept;
}
/** Whether this exact call's route is declared image-incapable. */
function matches(routes, options) {
    return routes.some(rule => rule.provider === options.provider
        && (rule.model === undefined || rule.model === options.model));
}
/** Whether the request would put an image block on the wire. */
function carriesImage(options) {
    return Array.isArray(options.messages)
        && options.messages.some(message => contentHasImage(message.content));
}
export function apply(ctx, config = {}) {
    const routes = normalize(config.routes);
    // Nothing declared: mount, do nothing, say nothing.
    if (routes.length === 0)
        return;
    let warnings = 0;
    const warnLimit = typeof config.warnLimit === 'number' && config.warnLimit >= 0 ? config.warnLimit : 5;
    const report = (message) => {
        if (warnings >= warnLimit)
            return;
        warnings += 1;
        ctx.logger.warn(`${name}: ${message}`);
    };
    const view = ctx.llm;
    const instance = (view[ORIGINAL] ?? view);
    const hadOwn = Object.hasOwn(instance, 'stream');
    const previous = instance.stream;
    const reported = new Set();
    const ours = function (options) {
        let next = options;
        try {
            if (matches(routes, options) && carriesImage(options)) {
                next = { ...options, messages: projectImagesForTextModel(options.messages) };
                const key = `${options.provider}/${options.model}`;
                if (!reported.has(key)) {
                    reported.add(key);
                    report(`projecting image blocks to text on "${key}": the route is declared image-incapable`);
                }
            }
        }
        catch {
            // Fail-open: a request this mount cannot read is dispatched untouched.
        }
        return previous.call(this, next);
    };
    instance.stream = ours;
    ctx.effect(() => () => {
        // Leave a wrapper someone else mounted on top of this one in place.
        if (instance.stream !== ours)
            return;
        if (hadOwn)
            instance.stream = previous;
        else
            delete instance.stream;
    });
}
