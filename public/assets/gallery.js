// Step 1 gallery: original folders with their thumbnails. The full sorting
// screen from the prototype replaces this in step 2.
const slug = location.pathname.split('/')[2];
const api = (p) => `/api/g/${encodeURIComponent(slug)}${p}`;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}

async function load() {
  const res = await fetch(api('/gallery'));
  if (res.status === 401) {
    location.reload(); // signed out elsewhere or expired: show the sign-in page
    return;
  }
  if (!res.ok) {
    $('status').textContent = "We couldn't load your photos. Please refresh the page to try again.";
    return;
  }
  const { order, folders, photos } = await res.json();
  document.title = `${order.title} · Family Preserves`;
  $('eyebrow').textContent = `Order ${order.code} · ${photos.length} photos`;
  $('title').textContent = order.title;
  $('status').textContent = photos.length ? '' : 'Your photos are on their way. Please check back soon.';

  const root = $('folders');
  for (const folder of folders) {
    const inFolder = photos.filter((p) => p.folder === folder.name);
    const grid = el(
      'div',
      { className: 'grid' },
      inFolder.map((p) =>
        el('a', { href: p.screen, target: '_blank', rel: 'noopener' }, [
          el('img', { src: p.thumb, alt: p.filename, loading: 'lazy', decoding: 'async' }),
        ])
      )
    );
    const heading = el('h2', { className: 'serif' }, [folder.name + ' ', el('span', { textContent: `${folder.count} photos` })]);
    root.append(el('section', { className: 'folder' }, [heading, grid]));
  }
}

$('signout').addEventListener('click', async () => {
  await fetch(api('/sign-out'), { method: 'POST' });
  location.reload();
});

load();
