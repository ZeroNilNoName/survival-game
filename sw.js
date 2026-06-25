const CACHE_NAME = 'survival-sandbox-v1';
const urlsToCache = [
    './',
    './index.html',
    './player.png'
    // Остальные текстуры и скрипты кэшируются автоматически при первом заходе
];

// Установка Service Worker и кэширование базовых файлов
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(urlsToCache);
        })
    );
    self.skipWaiting();
});

// Активация и удаление старого кэша
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Перехват сетевых запросов
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // НИКОГДА не кэшируем запросы к Socket.io и API сервера, чтобы мультиплеер работал корректно
    if (url.pathname.includes('/socket.io/') || url.pathname.includes('/api/')) {
        return event.respondWith(fetch(event.request));
    }

    // Стратегия: Сначала кэш, затем сеть (Cache-First)
    event.respondWith(
        caches.match(event.request).then(response => {
            if (response) {
                return response; // Берем из кэша, если есть
            }
            // Иначе идем в сеть
            return fetch(event.request).then(networkResponse => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }
                // Кэшируем новые файлы (например, текстуры, которые подгрузились позже)
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseToCache);
                });
                return networkResponse;
            }).catch(() => {
                // Если нет интернета и нет в кэше, возвращаем главную страницу (для офлайн-режима)
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});