export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Izinkan root homepage
  if (path === '/' || path === '') {
    return context.next();
  }

  // Izinkan /file/* dan /player
  if (path.startsWith('/file/') || path === '/player' || path === '/player.html') {
    return context.next();
  }

  // Semua selain itu → 404
  return new Response('404 Not Found', { status: 404 });
}
