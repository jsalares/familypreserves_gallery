// Sign-in page: send the access code, then reload into the gallery.
const slug = location.pathname.split('/')[2];
const form = document.getElementById('signin');
const input = document.getElementById('code');
const message = document.getElementById('message');
const button = form.querySelector('button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = input.value.trim();
  if (!code) {
    message.textContent = 'Please enter your access code.';
    input.focus();
    return;
  }
  button.disabled = true;
  message.textContent = '';
  try {
    const res = await fetch(`/api/g/${encodeURIComponent(slug)}/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      location.reload();
      return;
    }
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || 'Something went wrong. Please try again.';
  } catch {
    message.textContent = "We couldn't reach the gallery. Check your internet connection and try again.";
  }
  button.disabled = false;
  input.focus();
});
