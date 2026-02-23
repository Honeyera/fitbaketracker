import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function getAuthToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || SUPABASE_KEY;
  } catch {
    return SUPABASE_KEY;
  }
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

// INSERT one or more rows
export async function dbInsert(
  table: string,
  payload: Record<string, any> | Record<string, any>[]
): Promise<{ data: any; error: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const token = await getAuthToken();
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message || err.error || res.statusText } };
    }

    const data = await res.json().catch(() => null);
    return { data, error: null };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: null, error: { message: 'Request timed out after 15s' } };
    }
    return { data: null, error: { message: err.message } };
  }
}

// UPDATE rows matching a filter
export async function dbUpdate(
  table: string,
  payload: Record<string, any>,
  filterColumn: string,
  filterValue: string
): Promise<{ data: any; error: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const token = await getAuthToken();
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + table + '?' + filterColumn + '=eq.' + filterValue, {
      method: 'PATCH',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message || err.error || res.statusText } };
    }

    const data = await res.json().catch(() => null);
    return { data, error: null };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: null, error: { message: 'Request timed out after 15s' } };
    }
    return { data: null, error: { message: err.message } };
  }
}

// DELETE rows matching a filter
export async function dbDelete(
  table: string,
  filterColumn: string,
  filterValue: string
): Promise<{ data: any; error: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const token = await getAuthToken();
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + table + '?' + filterColumn + '=eq.' + filterValue, {
      method: 'DELETE',
      headers: {
        ...buildHeaders(token),
        'Prefer': 'return=minimal',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message || err.error || res.statusText } };
    }

    return { data: true, error: null };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: null, error: { message: 'Request timed out after 15s' } };
    }
    return { data: null, error: { message: err.message } };
  }
}

// DELETE rows matching IN filter (e.g. delete().in('id', [...ids]))
export async function dbDeleteIn(
  table: string,
  filterColumn: string,
  filterValues: string[]
): Promise<{ data: any; error: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const token = await getAuthToken();
    const inList = '(' + filterValues.map((v) => '"' + v + '"').join(',') + ')';
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + table + '?' + filterColumn + '=in.' + inList, {
      method: 'DELETE',
      headers: {
        ...buildHeaders(token),
        'Prefer': 'return=minimal',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message || err.error || res.statusText } };
    }

    return { data: true, error: null };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: null, error: { message: 'Request timed out after 15s' } };
    }
    return { data: null, error: { message: err.message } };
  }
}

// DELETE rows matching NEQ filter (e.g. delete().neq('id', ''))
export async function dbDeleteNeq(
  table: string,
  filterColumn: string,
  filterValue: string
): Promise<{ data: any; error: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const token = await getAuthToken();
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + table + '?' + filterColumn + '=neq.' + filterValue, {
      method: 'DELETE',
      headers: {
        ...buildHeaders(token),
        'Prefer': 'return=minimal',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      return { data: null, error: { message: err.message || err.error || res.statusText } };
    }

    return { data: true, error: null };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { data: null, error: { message: 'Request timed out after 15s' } };
    }
    return { data: null, error: { message: err.message } };
  }
}

// INSERT and return single row (for creates that need the ID back)
export async function dbInsertSingle(
  table: string,
  payload: Record<string, any>
): Promise<{ data: any; error: any }> {
  const result = await dbInsert(table, payload);
  if (result.error) return result;
  return { data: Array.isArray(result.data) ? result.data[0] : result.data, error: null };
}
