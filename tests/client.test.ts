import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';

const TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;
const SHORT = 'https://pro.housecallpro.com/mobile_estimate/Ex4mpl3Cod';
const ORG = '6e14b390-4b34-4338-a7c2-89d248ca25c8';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Minimal estimate envelope in the real shape. */
function estimateBody() {
  return {
    object: 'customer_estimate',
    estimate: { object: 'customer_estimate', data: { estimate_number: '900000001' } },
    options: { object: 'list', data: [] },
  };
}

function clientFor(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  return new HousecallProClient(new LinkRegistry(env), { fetchImpl });
}

describe('HousecallProClient.getEstimate', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn();
  });

  it('reads an estimate with the token in the path and no Authorization header', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(estimateBody()));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);

    const out = await client.getEstimate();

    expect(out.estimate.data.estimate_number).toBe('900000001');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://app.housecallpro.com/alpha/customer_estimates/${TOKEN}`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('follows a short link once and reuses the resolved token', async () => {
    fetchImpl
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: `https://client.housecallpro.com/estimates/${TOKEN}` },
        }),
      )
      .mockImplementation(() => Promise.resolve(jsonResponse(estimateBody())));

    const client = clientFor({ HOUSECALLPRO_LINK: SHORT }, fetchImpl as unknown as typeof fetch);
    await client.getEstimate();
    await client.getEstimate();

    // 1 redirect probe + 2 reads: the short link is resolved once, not per call.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('reports an expired link distinctly from an outage', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(/expired|revoked|new link/i);
  });

  it('reports a 404 as a stale link rather than a bug', async () => {
    fetchImpl.mockResolvedValue(new Response('<html>404</html>', { status: 404 }));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(/404|no longer/i);
  });

  it('does not put the token in the error message', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }) as Error,
    );
  });

  it('treats a 200 that is not JSON as an upstream problem, not data', async () => {
    fetchImpl.mockResolvedValue(new Response('<html>hi</html>', { status: 200 }));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(/JSON|unexpected/i);
  });

  it('fails a short link whose redirect carries no usable token', async () => {
    fetchImpl.mockResolvedValue(
      new Response(null, { status: 301, headers: { location: 'https://client.housecallpro.com/' } }),
    );
    const client = clientFor({ HOUSECALLPRO_LINK: SHORT }, fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(/resolve/i);
  });
});

describe('HousecallProClient.getOrganization', () => {
  it('reads an organization by uuid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ company_name: 'Queen City' }));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);

    const out = await client.getOrganization(ORG);

    expect(out['company_name']).toBe('Queen City');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://app.housecallpro.com/alpha/organizations/${ORG}`);
  });

  it('rejects an organization id that is not a uuid before making a request', async () => {
    const fetchImpl = vi.fn();
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.getOrganization('../etc/passwd')).rejects.toThrow(/uuid/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HousecallProClient.declineOptions', () => {
  it('posts the option uuids with the token in the Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);

    await client.declineOptions(['est_1', 'est_2']);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.housecallpro.com/api/estimates/estimate_options/customer_declines');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Token ${TOKEN}`);
    const body = init.body as URLSearchParams;
    expect(body.getAll('estimate_option_uuids[]')).toEqual(['est_1', 'est_2']);
  });

  it('refuses an empty option list without calling the network', async () => {
    const fetchImpl = vi.fn();
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.declineOptions([])).rejects.toThrow(/at least one/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HousecallProClient.approveOptions', () => {
  it('refuses up front, naming reCAPTCHA, without touching the network', async () => {
    const fetchImpl = vi.fn();
    const client = clientFor({ HOUSECALLPRO_LINK: TOKEN }, fetchImpl as unknown as typeof fetch);
    await expect(client.approveOptions(['est_1'])).rejects.toThrow(/reCAPTCHA/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
