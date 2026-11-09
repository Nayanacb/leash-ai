import { MERCHANT_CATEGORIES, type MerchantCategory, type MerchantDto } from '@leash/shared';
import { useState, type FormEvent } from 'react';
import { useCreateMerchant, useMerchants, useUpdateMerchant } from '../../api/merchants';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Form';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { LifecycleStatus } from '../../components/ui/StatusPill';
import { humanize } from '../../lib/format';

export function MerchantsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const merchants = useMerchants(showArchived);
  const update = useUpdateMerchant();
  const [editing, setEditing] = useState<MerchantDto | 'new' | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Merchants"
        description="The PayPal sandbox payees your agents are allowed to pay. Agents refer to merchants by ID and never choose the payee themselves."
        actions={<Button onClick={() => setEditing('new')}>Add merchant</Button>}
      />

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived merchants
      </label>
      <ErrorMessage error={update.error} />

      {merchants.isPending ? (
        <Loading />
      ) : merchants.isError ? (
        <ErrorMessage error={merchants.error} />
      ) : merchants.data.length === 0 ? (
        <EmptyState title="No merchants registered">
          Add the PayPal sandbox business accounts your agents may pay.
        </EmptyState>
      ) : (
        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>Merchant</Th>
                <Th>PayPal account</Th>
                <Th>Category</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {merchants.data.map((m) => (
                <tr key={m.id} className={m.archived ? 'bg-slate-50/60' : undefined}>
                  <Td>
                    <span className="font-medium text-slate-900">{m.displayName}</span>
                    {m.domain && <span className="block text-xs text-slate-500">{m.domain}</span>}
                  </Td>
                  <Td>
                    <span className="break-all">{m.paypalEmail}</span>
                    {m.paypalMerchantId && (
                      <span className="block font-mono text-xs text-slate-500">
                        {m.paypalMerchantId}
                      </span>
                    )}
                  </Td>
                  <Td>{humanize(m.category)}</Td>
                  <Td>
                    <LifecycleStatus status={m.archived ? 'ARCHIVED' : 'ACTIVE'} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({ id: m.id, patch: { archived: !m.archived } })
                        }
                      >
                        {m.archived ? 'Restore' : 'Archive'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}

      {editing && (
        <MerchantDialog
          merchant={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function MerchantDialog({
  merchant,
  onClose,
}: {
  merchant: MerchantDto | null;
  onClose: () => void;
}) {
  const create = useCreateMerchant();
  const update = useUpdateMerchant();
  const mutation = merchant ? update : create;
  const [form, setForm] = useState({
    displayName: merchant?.displayName ?? '',
    paypalEmail: merchant?.paypalEmail ?? '',
    paypalMerchantId: merchant?.paypalMerchantId ?? '',
    domain: merchant?.domain ?? '',
    category: (merchant?.category ?? 'electronics') as MerchantCategory,
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const payeeChanged =
    merchant !== null && form.paypalEmail.trim().toLowerCase() !== merchant.paypalEmail;

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      displayName: form.displayName,
      paypalEmail: form.paypalEmail,
      paypalMerchantId: form.paypalMerchantId.trim() || null,
      domain: form.domain.trim() || null,
      category: form.category,
    };
    if (merchant) update.mutate({ id: merchant.id, patch: body }, { onSuccess: onClose });
    else create.mutate(body, { onSuccess: onClose });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={merchant ? `Edit ${merchant.displayName}` : 'Add merchant'}
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorMessage error={mutation.error} />
        <Field label="Display name">
          {(id) => (
            <Input
              id={id}
              required
              maxLength={100}
              value={form.displayName}
              onChange={set('displayName')}
            />
          )}
        </Field>
        <Field
          label="PayPal sandbox account email"
          hint="The business account that receives payment."
        >
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              value={form.paypalEmail}
              onChange={set('paypalEmail')}
            />
          )}
        </Field>
        {payeeChanged && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-600/20">
            Changing the PayPal account changes who gets paid. This change is recorded in the audit
            log.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="PayPal merchant ID (optional)">
            {(id) => (
              <Input
                id={id}
                maxLength={13}
                placeholder="13 characters"
                value={form.paypalMerchantId}
                onChange={set('paypalMerchantId')}
              />
            )}
          </Field>
          <Field label="Website domain (optional)">
            {(id) => (
              <Input
                id={id}
                placeholder="shop.example.com"
                value={form.domain}
                onChange={set('domain')}
              />
            )}
          </Field>
        </div>
        <Field label="Category">
          {(id) => (
            <Select id={id} value={form.category} onChange={set('category')}>
              {MERCHANT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {merchant ? 'Save changes' : 'Add merchant'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
