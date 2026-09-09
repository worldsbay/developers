export function el<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing interface element: ${selector}`);
  return element;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-yoworlds': '1',
      'x-pocketbeyond': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Something went wrong. Please retry.');
  return data;
}
export function toast(message: string, error = false) {
  const node = el('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 6000);
}
let toastTimer = 0;
export async function action(button: HTMLButtonElement, work: () => Promise<void>) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await work();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Something went wrong.', true);
  } finally {
    if (button.isConnected) button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
