// Kilocode: Tool Approval
// owner: team-backend
// justification: opt-in public web search for the existing research workflow
// allowedDomains: google.serper.dev; operator-approved SERPER_ALLOWED_HOSTS
// allowedDataPaths: []
// sideEffects: { network: true, write: false }
// inputSchema: serperWebSearchInputSchema (below)
// outputSchema: serperWebSearchOutputSchema (below)
// reviewer: pending maintainer review; prepared on a fork only
// approvalDate: pending maintainer review
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { AISpanType } from '@mastra/core/ai-tracing'
import { log } from '../config/logger'

// Candidate for etheia-agent-map — the canonical repository was inaccessible.
// See: https://github.com/Etheia-Consulting-LLC/etheia-agent-map
// Schema, logging and tracing structure follows the local SerpAPI search tool.
export const serperWebSearchInputSchema = z.object({
    query: z.string().trim().min(1).describe('Public web search query'),
    numResults: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe('Requested results, bounded to ten'),
})

const organicResultSchema = z.object({
    title: z.string().min(1),
    link: z
        .url()
        .refine(
            (url) => /^https?:/.test(url),
            'Expected an HTTP(S) result URL'
        ),
    snippet: z.string().optional().default(''),
})

export const serperWebSearchOutputSchema = z.object({
    results: z.array(
        z.object({
            title: z.string(),
            url: z.url(),
            content: z.string(),
        })
    ),
    contentType: z.literal('snippet'),
})

// Reserve slots synchronously so concurrent calls remain at least one second apart.
let nextRequestAt = 0

class SearchProviderError extends Error {}

function setting(name: string, fallback: string): string {
    const value = (process.env[name] ?? '').trim()
    return value.length > 0 ? value : fallback
}

export const serperSearchTool = createTool({
    id: 'serper-web-search',
    description:
        'Find public Google web results via a Serper-compatible endpoint. Returns titles, URLs and snippets as content, not full pages or Scholar/news/financial metadata.',
    inputSchema: serperWebSearchInputSchema,
    outputSchema: serperWebSearchOutputSchema,
    execute: async ({ context, tracingContext, runtimeContext }) => {
        const input = serperWebSearchInputSchema.parse(context)
        const numResults = Math.min(10, input.numResults)
        const requestId = crypto.randomUUID()
        const actor = String(runtimeContext?.get('userId') ?? 'unknown')
        const timestamp = new Date().toISOString()
        const span = tracingContext?.currentSpan?.createChildSpan({
            type: AISpanType.TOOL_CALL,
            name: 'serper-web-search',
            input: {
                requestId,
                actor,
                timestamp,
                queryLength: input.query.length,
                numResults,
            },
        })
        log.info('Serper web search started', {
            requestId,
            actor,
            timestamp,
            numResults,
        })

        try {
            const apiKey = setting('SERPER_API_KEY', '')
            if (apiKey.length === 0) {
                throw new SearchProviderError(
                    'SERPER_API_KEY is required; other provider credentials are not used'
                )
            }
            const baseUrl = new URL(
                setting('SERPER_BASE_URL', 'https://google.serper.dev')
            )
            const allowedHosts = setting(
                'SERPER_ALLOWED_HOSTS',
                'google.serper.dev'
            )
                .split(',')
                .map((hostname) => hostname.trim().toLowerCase())
                .filter(Boolean)
            if (
                baseUrl.protocol !== 'https:' ||
                baseUrl.username ||
                baseUrl.password ||
                baseUrl.search ||
                baseUrl.hash ||
                !allowedHosts.includes(baseUrl.hostname.toLowerCase())
            ) {
                throw new SearchProviderError(
                    'Search endpoint must be HTTPS and included in SERPER_ALLOWED_HOSTS, without URL credentials, query or fragment'
                )
            }
            const url = new URL(baseUrl.href.replace(/\/+$/, '') + '/search')
            const configuredTimeout = Number(
                setting('SERPER_TIMEOUT_MS', '60000')
            )
            const timeout =
                Number.isSafeInteger(configuredTimeout) &&
                configuredTimeout > 0 &&
                configuredTimeout <= 4_294_967_295
                    ? configuredTimeout
                    : 60_000
            const now = Date.now()
            const wait = Math.max(0, nextRequestAt - now)
            nextRequestAt = now + wait + 1000
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait))
            }
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: input.query, num: numResults }),
                signal: AbortSignal.timeout(timeout),
                redirect: 'error',
            })
            if (!response.ok) {
                throw new SearchProviderError(
                    'Search provider returned HTTP ' + response.status
                )
            }
            const data = z
                .object({
                    organic: z.array(z.unknown()).default([]),
                    error: z.unknown().optional(),
                })
                .parse(await response.json())
            const providerFailed = Boolean(data.error)
            if (providerFailed) {
                throw new SearchProviderError(
                    'Search provider returned an error'
                )
            }
            const results = data.organic
                .slice(0, numResults)
                .flatMap((item) => {
                    const parsed = organicResultSchema.safeParse(item)
                    return parsed.success
                        ? [
                              {
                                  title: parsed.data.title,
                                  url: parsed.data.link,
                                  content: parsed.data.snippet,
                              },
                          ]
                        : []
                })
            const output = serperWebSearchOutputSchema.parse({
                results,
                contentType: 'snippet',
            })
            span?.end({
                output: { resultCount: results.length, outcome: 'success' },
            })
            log.info('Serper web search completed', {
                requestId,
                actor,
                timestamp,
                outcome: 'success',
                resultCount: results.length,
            })
            return output
        } catch (error) {
            // Never forward provider bodies, configured URLs or raw transport errors.
            const message =
                error instanceof SearchProviderError
                    ? error.message
                    : 'Serper web search failed'
            span?.end({
                metadata: {
                    requestId,
                    actor,
                    timestamp,
                    outcome: 'failure',
                    error: message,
                },
            })
            log.error('Serper web search failed', {
                requestId,
                actor,
                timestamp,
                outcome: 'failure',
                error: message,
            })
            throw new Error(message)
        }
    },
})

// Opt-in registration supplies the name already used by researchAgent instructions.
export const optionalWebSearchTools =
    setting('SERPER_API_KEY', '').length > 0
        ? { webSearchTool: serperSearchTool }
        : {}
