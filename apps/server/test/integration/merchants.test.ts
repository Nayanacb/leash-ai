import { describe, expect, it } from 'vitest';
import { db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();

describe('merchant registry', () => {
  it('registers a merchant with PayPal details and a category', async () => {
    const user = await UserClient.register(app);
    const res = await user.post('/api/v1/merchants', {
      displayName: 'Office Depot Sandbox',
      paypalEmail: ' Seller@Business.Example.TEST ',
      paypalMerchantId: 'abcdefghjk123',
      domain: 'Shop.Example.com',
      category: 'office_supplies',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      displayName: 'Office Depot Sandbox',
      paypalEmail: 'seller@business.example.test',
      paypalMerchantId: 'ABCDEFGHJK123',
      domain: 'shop.example.com',
      category: 'office_supplies',
      archived: false,
    });
  });

  it.each([
    ['bad email', { paypalEmail: 'nope' }],
    ['bad PayPal merchant id', { paypalMerchantId: 'short' }],
    ['bad domain', { domain: 'http://evil.example/path' }],
    ['unknown category', { category: 'weapons' }],
    ['empty name', { displayName: '' }],
    ['control characters in name', { displayName: 'Cable\u0000Co' }],
  ])('rejects %s', async (_name, override) => {
    const user = await UserClient.register(app);
    const res = await user.post('/api/v1/merchants', {
      displayName: 'Cable Co',
      paypalEmail: 'seller@cable.example.test',
      category: 'electronics',
      ...override,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate PayPal email for the same user only', async () => {
    const alice = await UserClient.register(app);
    const bob = await UserClient.register(app);
    await alice.createMerchant({ paypalEmail: 'shared@seller.example.test' });
    expect(
      (
        await alice.post('/api/v1/merchants', {
          displayName: 'Again',
          paypalEmail: 'SHARED@seller.example.test',
          category: 'other',
        })
      ).status,
    ).toBe(409);
    // A different user may register the same payee.
    await bob.createMerchant({ paypalEmail: 'shared@seller.example.test' });
  });

  it('edits are audited field by field, with payee changes flagged', async () => {
    const user = await UserClient.register(app);
    const merchant = await user.createMerchant({ paypalEmail: 'old@seller.example.test' });
    const res = await user.patch(`/api/v1/merchants/${merchant.id}`, {
      displayName: 'Renamed',
      paypalEmail: 'new@seller.example.test',
      domain: '',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      displayName: 'Renamed',
      paypalEmail: 'new@seller.example.test',
      domain: null,
    });

    const event = await db().auditEvent.findFirstOrThrow({
      where: { userId: user.user.id, action: 'merchant.updated' },
    });
    expect(event.data).toMatchObject({
      merchantId: merchant.id,
      payeeChanged: true,
      changes: {
        displayName: { from: 'Cable Co', to: 'Renamed' },
        paypalEmail: { from: 'old@seller.example.test', to: 'new@seller.example.test' },
      },
    });
  });

  it('archives and restores, hiding archived merchants by default', async () => {
    const user = await UserClient.register(app);
    const merchant = await user.createMerchant();
    expect(
      (await user.patch(`/api/v1/merchants/${merchant.id}`, { archived: true })).body.archived,
    ).toBe(true);
    expect((await user.get('/api/v1/merchants')).body.merchants).toEqual([]);
    expect((await user.get('/api/v1/merchants?includeArchived=true')).body.merchants).toHaveLength(
      1,
    );
    expect(
      (await user.patch(`/api/v1/merchants/${merchant.id}`, { archived: false })).body.archived,
    ).toBe(false);

    const actions = (
      await db().auditEvent.findMany({ where: { userId: user.user.id }, orderBy: { seq: 'asc' } })
    ).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['merchant.archived', 'merchant.restored']));
  });

  it('rejects an empty update', async () => {
    const user = await UserClient.register(app);
    const merchant = await user.createMerchant();
    expect((await user.patch(`/api/v1/merchants/${merchant.id}`, {})).status).toBe(400);
  });
});
