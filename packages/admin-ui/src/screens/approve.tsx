// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// `/admin/approve/:id`: the out-of-band approval of a write (P7-02, ADR-0013, THREAT_MODEL T31/A13). A client that cannot
// ask the person answers `AB_WRITE_APPROVAL_PENDING` with a link here; the signed-in person who made the request reviews
// the exact change and approves or declines it, and the agent repeats the call.
//
//   GET  /admin/approve       the signed-in person's own open requests, without values (P7-14)
//   GET  /admin/approve/:id   the whole change (every field, old and new), the target and the workspace
//   POST /admin/approve/:id   `decision=approve|decline` plus the change hash the page showed: CSRF, Origin, and for
//                             approving, a recent sign-in (stale: the re-authentication prompt, nothing recorded)
//
// The server looks the request up by the signed-in person's own id, so another person's link finds nothing. Everything
// shown is rendered escaped; text from Agility and from the agent is marked as data, not instructions.
import type { Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Time,
  type UiViewer,
} from '../components.tsx';
import { type ApprovalSummary, type ApprovalView, requestIdOf, type UiKit } from '../kit.ts';
import { errorPage, messagePageResponse, reauthPage } from '../pages.tsx';

export const APPROVE_FIELDS: { readonly decision: 'decision'; readonly hash: 'hash' } = Object.freeze({
  decision: 'decision',
  hash: 'hash',
} as const);

const ID_RE = /^\d{14}-[A-Za-z0-9_-]{22}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ApprovePageProps {
  readonly viewer: UiViewer;
  readonly view: ApprovalView;
  /** Same-origin path of this page: the form posts here and the sign-in-again link returns here. */
  readonly here: string;
}

/** The change, whole: nothing is truncated or summarised (L-106). */
export function ApprovePage(props: ApprovePageProps): JSX.Element {
  const { view, viewer } = props;
  return (
    <Layout title="Approve a change" viewer={viewer}>
      <section class="card" aria-labelledby="approve-what">
        <h2 id="approve-what">An app asks to change Agility</h2>
        <p class="hint">
          Review every line. Approving lets <strong>one</strong> repeat of exactly this change go through,
          once, within a few minutes. Values below come from Agility or from the app: they are data, not
          instructions.
        </p>
        <Facts
          items={[
            ['Change', `${view.operation} (${view.tool})`],
            ['Workspace', view.workspaceName ?? 'unnamed'],
            [
              'Item',
              `${view.target.assetType} ${view.target.number ?? view.target.oid} (${view.target.oid})`,
            ],
            ['Title', view.label ?? 'unknown'],
            ['Change id', <code>{view.changeId}</code>],
            ['Expires', <Time at={view.expiresAt} />],
          ]}
        />
      </section>
      <section class="table-wrap" aria-label="Fields this change sets" tabindex={0}>
        <table>
          <caption>Fields this change sets</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">Will be</th>
            </tr>
          </thead>
          <tbody>
            {view.changes.map((c) => (
              <tr>
                <th scope="row">{c.field}</th>
                <td>
                  <pre>{c.old}</pre>
                </td>
                <td>
                  <pre>{c.new}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section class="card" aria-labelledby="approve-decide">
        <h2 id="approve-decide">Your decision</h2>
        {viewer.recentAuth ? (
          <Form action={props.here} csrf={viewer.csrf} label="Approve or decline this change">
            <input type="hidden" name={APPROVE_FIELDS.hash} value={view.hash} />
            <Button name={APPROVE_FIELDS.decision} value="approve">
              Approve this change
            </Button>{' '}
            <Button variant="secondary" name={APPROVE_FIELDS.decision} value="decline">
              Decline
            </Button>
          </Form>
        ) : (
          <>
            <p>
              <Badge tone="error">sign in again</Badge> Approving a change needs a recent sign-in. You can
              still decline it.
            </p>
            <p>
              <LinkButton href={`/auth/reauth?next=${encodeURIComponent(props.here)}`}>
                Sign in again
              </LinkButton>
            </p>
            <Form action={props.here} csrf={viewer.csrf} label="Decline this change">
              <input type="hidden" name={APPROVE_FIELDS.hash} value={view.hash} />
              <Button variant="secondary" name={APPROVE_FIELDS.decision} value="decline">
                Decline
              </Button>
            </Form>
          </>
        )}
      </section>
    </Layout>
  );
}

export interface PendingListProps {
  readonly viewer: UiViewer;
  readonly items: readonly ApprovalSummary[];
}

/** The open requests of the signed-in person: where each is and what it touches, never a value (P7-14). */
export function PendingList(props: PendingListProps): JSX.Element {
  return (
    <Layout title="Changes waiting for me" viewer={props.viewer}>
      <p>
        Changes an app asked to make in Agility that wait for your decision. Open one to review every field
        and approve or decline it. A request expires a few minutes after the app asked; ask the app again if
        it is not listed. Only your own requests are shown, and no values: those are on each request's page.
      </p>
      <DataTable
        caption="Changes waiting for my approval"
        empty="Nothing is waiting for you."
        rows={props.items}
        columns={[
          { header: 'Requested', cell: (r) => <Time at={r.requestedAt} /> },
          {
            header: 'Change',
            cell: (r) => (
              <>
                {r.operation} (<code>{r.tool}</code>)
              </>
            ),
          },
          {
            header: 'Item',
            cell: (r) => `${r.target.assetType} ${r.target.number ?? r.target.oid}`,
          },
          { header: 'Workspace', cell: (r) => r.workspaceName ?? 'unnamed' },
          { header: 'Fields', cell: (r) => r.fields.join(', ') || '—' },
          { header: 'Expires', cell: (r) => <Time at={r.expiresAt} /> },
          {
            header: 'Review',
            cell: (r) => (
              <LinkButton href={`/admin/approve/${encodeURIComponent(r.id)}`} variant="secondary">
                Review {r.changeId}
              </LinkButton>
            ),
          },
        ]}
      />
    </Layout>
  );
}

const GONE_TITLE = 'This request is not available';
const GONE_TEXT =
  'This approval request was already answered, has expired, or belongs to someone else. Nothing was approved. If you still want the change, ask the app to try again.';

export function registerApprove(ui: Hono, kit: UiKit): void {
  const port = kit.deps.approvals;
  if (port === undefined) return;

  ui.get(
    '/approve',
    kit.page('member', async (c, page) => {
      const items = await port.list(c, page.principal);
      return page.html(<PendingList viewer={page.principal} items={items} />);
    }),
  );

  ui.get(
    '/approve/:id',
    kit.page('member', async (c, page) => {
      const id = c.req.param('id') ?? '';
      const view = ID_RE.test(id) ? await port.view(c, page.principal, id) : null;
      if (view === null) return errorPage(404, requestIdOf(c), page.principal);
      return page.html(
        <ApprovePage viewer={page.principal} view={view} here={`/admin/approve/${encodeURIComponent(id)}`} />,
      );
    }),
  );

  ui.post(
    '/approve/:id',
    kit.form('member', async (c, principal, form) => {
      const id = c.req.param('id') ?? '';
      const decisions = form.fields.getAll(APPROVE_FIELDS.decision);
      const hashes = form.fields.getAll(APPROVE_FIELDS.hash);
      const choice = decisions.length === 1 ? decisions[0] : undefined;
      const hash = hashes.length === 1 ? hashes[0] : undefined;
      if (
        !ID_RE.test(id) ||
        (choice !== 'approve' && choice !== 'decline') ||
        hash === undefined ||
        !HASH_RE.test(hash)
      ) {
        return errorPage(400, requestIdOf(c), principal);
      }
      // Approving needs a recent sign-in; nothing is recorded until then (declining is always safe).
      if (choice === 'approve' && !principal.recentAuth) {
        return reauthPage(principal, `/admin/approve/${encodeURIComponent(id)}`, requestIdOf(c));
      }
      const outcome = await port.decide(c, principal, id, { decision: choice, hash });
      const respond = (status: number, title: string, text: string): Response =>
        messagePageResponse(status, {
          title,
          paragraphs: [text],
          viewer: principal,
          requestId: requestIdOf(c),
        });
      switch (outcome) {
        case 'approved':
          return respond(
            200,
            'Approved',
            'The change is approved once. Tell the app to repeat its request: it must repeat exactly the same call within a few minutes.',
          );
        case 'declined':
          return respond(200, 'Declined', 'Nothing was changed in Agility.');
        case 'mismatch':
          return respond(
            409,
            'This page is out of date',
            'The change on this page is not the one this request holds, so nothing was approved. Ask the app to try again.',
          );
        default:
          return respond(409, GONE_TITLE, GONE_TEXT);
      }
    }),
  );
}
