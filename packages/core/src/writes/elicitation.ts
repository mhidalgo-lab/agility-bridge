// SPDX-License-Identifier: Apache-2.0
// The elicitation approval channel (ADR-0013, P0-07): built per call from the request the SDK hands the tool.
// - 2026-07-28: the request carries its protocol version and client capabilities in `_meta`. A client that declared
//   elicitation is answered with `input_required` and repeats the call with the answer (multi round-trip).
// - 2025-era: the client declared its capabilities at `initialize`; only a connection that keeps them (stdio) can be
//   asked, with a push `elicitation/create`. Stateless HTTP requests carry none, so they cannot be elicited (L-025).
// A client without the capability gets no channel at all: the pipeline then answers `AB_WRITE_APPROVAL_UNAVAILABLE`
// itself, because the SDK would turn an unanswerable `input_required` into a protocol error (P0-07 finding 7).
import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { AbError, ErrorCode } from '../errors.ts';
import type { ApprovalChannelPort, ApprovalPrompt } from './runtime.ts';

/** The key of our one question in `inputRequests` / `inputResponses`. */
export const APPROVAL_INPUT_KEY: string = 'approval';

/** Form-mode elicitation: `{}` means form (the 2025 default), `{ form }` says so; URL-only does not qualify. */
export function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation as Record<string, unknown> | undefined;
  if (e === undefined || e === null || typeof e !== 'object') return false;
  return e['form'] !== undefined || Object.keys(e).length === 0;
}

/** URL-mode elicitation (MCP 2025-11): the client declared `elicitation.url`. Form-only (`{}` or `{ form }`) does not qualify. */
export function supportsUrlElicitation(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation as Record<string, unknown> | undefined;
  if (e === undefined || e === null || typeof e !== 'object') return false;
  const url = e['url'];
  return url !== undefined && url !== null && typeof url === 'object';
}

/** The longest a call waits for the client to react to the open-this-link request (the link is returned either way). */
export const URL_ELICITATION_TIMEOUT_MS: number = 30_000;
/** Fixed text: it names no change, target or value. Opening the link approves nothing. */
export const URL_ELICITATION_MESSAGE: string =
  'Open the approval page to review the change and approve or decline it there. Opening this link approves nothing.';

/** Only the page's own http(s) link, without credentials, is handed to a client to open. */
function openableLink(link: string): string | undefined {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (u.username !== '' || u.password !== '') return undefined;
    return link;
  } catch {
    return undefined;
  }
}

/**
 * The approval page as the channel, plus (P7-46) a request to the client to open the page's link when it declared
 * `elicitation.url`. Only where the server can push a request (a 2025-era connection that kept its capabilities, such as
 * stdio): the answer is the page's own `pending` answer, unchanged, and the person still approves on the page, so URL
 * mode can never approve anything. A failure, a decline or a client that ignores the request changes nothing.
 */
export function withUrlElicitation(
  page: ApprovalChannelPort,
  sdk: ServerContext,
  legacyCapabilities: () => ClientCapabilities | undefined,
): ApprovalChannelPort {
  const envelope = sdk.mcpReq.envelope as Record<string, unknown> | undefined;
  if (envelope !== undefined && typeof envelope[PROTOCOL_VERSION_META_KEY] === 'string') return page;
  return {
    ...page,
    ask: async (prompt) => {
      const reply = await page.ask(prompt);
      if (reply.status !== 'pending' || !supportsUrlElicitation(legacyCapabilities())) return reply;
      const url = openableLink(reply.link);
      if (url === undefined) return reply;
      try {
        await sdk.mcpReq.elicitInput(
          { mode: 'url', message: URL_ELICITATION_MESSAGE, url, elicitationId: crypto.randomUUID() },
          { timeout: URL_ELICITATION_TIMEOUT_MS, signal: sdk.mcpReq.signal },
        );
      } catch {
        // A client that cannot or will not open the link still gets the plain link in the answer.
      }
      return reply;
    },
  };
}

function answerOf(responses: Record<string, unknown> | undefined): 'approve' | 'decline' | 'none' {
  const r = responses?.[APPROVAL_INPUT_KEY] as { action?: unknown; content?: unknown } | undefined;
  if (r === undefined || r === null || typeof r !== 'object' || typeof r.action !== 'string') return 'none';
  const content = r.content as { approve?: unknown } | undefined;
  return r.action === 'accept' && content?.approve === true ? 'approve' : 'decline';
}

/**
 * The channel this request can use, or `undefined`. `legacyCapabilities` reads what the connection declared at
 * `initialize` (stdio); it is not consulted on a 2026-07-28 request.
 */
export function elicitationChannel(
  sdk: ServerContext,
  legacyCapabilities: () => ClientCapabilities | undefined,
): ApprovalChannelPort | undefined {
  const envelope = sdk.mcpReq.envelope as Record<string, unknown> | undefined;
  const modern = envelope !== undefined && typeof envelope[PROTOCOL_VERSION_META_KEY] === 'string';
  if (modern) {
    if (!supportsFormElicitation(envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)) {
      return undefined;
    }
    const state = sdk.mcpReq.requestState<unknown>();
    return {
      kind: 'elicitation',
      ...(typeof state === 'string'
        ? { resume: { state, answer: answerOf(sdk.mcpReq.inputResponses) } }
        : {}),
      ask: async () => ({ status: 'needs_input' }),
    };
  }
  if (!supportsFormElicitation(legacyCapabilities())) return undefined;
  return {
    kind: 'elicitation',
    sameCall: true,
    ask: async (prompt: ApprovalPrompt) => {
      try {
        const r = await sdk.mcpReq.elicitInput({
          message: prompt.message,
          requestedSchema: prompt.requestedSchema as never,
        });
        const content = r.content as { approve?: unknown } | undefined;
        return { status: 'answered', approved: r.action === 'accept' && content?.approve === true };
      } catch {
        throw new AbError(
          ErrorCode.WriteApprovalUnavailable,
          'This client could not be asked to approve the change, so nothing was changed.',
          { hint: 'Use a client that supports elicitation. See docs/guide/write-tools.md.' },
        );
      }
    },
  };
}
