// client.js — Умный сетевой модуль интеграции
let socket = null;
let isMultiplayerMode = false;
let serverIp = "localhost:3000";
let remotePlayers = {};
let isIncomingSync = false;

document.addEventListener("DOMContentLoaded", () => {
    // Даем оригинальному коду 100мс на инициализацию его кнопок, затем добавляем свои
    setTimeout(initNetworkMenu, 100);
});

function initNetworkMenu() {
    const startBtn = document.getElementById("startBtn");
    if (!startBtn) return;

    // Автоматически находим оригинальную панель меню через родителя кнопки Старт
    const mainPanel = startBtn.parentElement;
    const multiplayerPanel = document.getElementById("menuMultiplayerPanel");
    const mpModeBtn = document.getElementById("multiplayerModeBtn");
    const connectBtn = document.getElementById("connectMultiplayerBtn");
    const backBtn = document.getElementById("multiBackBtn");

    if (mpModeBtn && mainPanel && multiplayerPanel) {
        // Переход в меню мультиплеера
        mpModeBtn.addEventListener("click", () => {
            mainPanel.style.display = "none";
            multiplayerPanel.style.display = "flex";
        });
    }

    if (backBtn && mainPanel && multiplayerPanel) {
        // Возврат в главное меню
        backBtn.addEventListener("click", () => {
            multiplayerPanel.style.display = "none";
            mainPanel.style.display = "flex";
        });
    }

    if (connectBtn) {
        connectBtn.addEventListener("click", () => {
            serverIp = document.getElementById("serverIpInput").value.trim() || "localhost:3000";
            connectToServer();
        });
    }
}

function connectToServer() {
    showNotification("Подключение к " + serverIp + "...");
    
    // Динамически загружаем библиотеку socket.io с запущенного сервера
    const script = document.createElement('script');
    script.src = `http://${serverIp}/socket.io/socket.io.js`;
    script.onload = () => { setupNetworkHandlers(); };
    script.onerror = () => {
        alert("Ошибка сети! Проверьте, запущен ли server.js и правильно ли указан IP.");
    };
    document.head.appendChild(script);
}

function setupNetworkHandlers() {
    socket = io(`http://${serverIp}`);

    socket.on('connect', () => {
        isMultiplayerMode = true;
    });

    socket.on('init_world', (data) => {
        isIncomingSync = true;
        
        // Синхронизируем постройки из базы данных сервера
        if (window.worldModifications && data.worldModifications) {
            window.worldModifications.clear();
            for (let key in data.worldModifications) {
                window.worldModifications.set(key, data.worldModifications[key]);
            }
        }
        
        remotePlayers = data.players;
        delete remotePlayers[socket.id];
        
        isIncomingSync = false;
        
        // Инициализация сети завершена, изящно запускаем оригинальный движок игры!
        launchGameViaNativeEngine();
    });

    socket.on('player_joined', (playerData) => {
        remotePlayers[playerData.id] = playerData;
        showNotification(`Игрок ${playerData.id.substring(0, 5)} подключился.`);
    });

    socket.on('player_updated', (playerData) => {
        remotePlayers[playerData.id] = playerData;
    });

    socket.on('player_left', (id) => {
        showNotification(`Игрок ${id.substring(0, 5)} покинул мир.`);
        delete remotePlayers[id];
    });

    socket.on('tile_modified', (data) => {
        isIncomingSync = true;
        if (window.worldModifications) {
            if (data.value === null) {
                window.worldModifications.delete(data.key);
            } else {
                window.worldModifications.set(data.key, data.value);
            }
        }
        isIncomingSync = false;
    });
}

function launchGameViaNativeEngine() {
    const multiplayerPanel = document.getElementById("menuMultiplayerPanel");
    if (multiplayerPanel) multiplayerPanel.style.display = "none";
    
    // Эмуляция нажатия на стандартную кнопку "Играть" запускает оригинальные циклы шкал и рендеринга
    const startBtn = document.getElementById("startBtn");
    if (startBtn) {
        startBtn.click();
    }
    showNotification("Успешное подключение к серверу!");
}

// ПЕРЕХВАТ ИЗМЕНЕНИЙ КАРТЫ (Крафт, строительство, разрушение)
setTimeout(() => {
    if (window.worldModifications) {
        const originalSet = window.worldModifications.set;
        window.worldModifications.set = function(key, value) {
            const result = originalSet.call(window.worldModifications, key, value);
            if (isMultiplayerMode && !isIncomingSync && socket) {
                socket.emit('tile_modify', { key, value });
            }
            return result;
        };

        const originalDelete = window.worldModifications.delete;
        window.worldModifications.delete = function(key) {
            const result = originalDelete.call(window.worldModifications, key);
            if (isMultiplayerMode && !isIncomingSync && socket) {
                socket.emit('tile_modify', { key, value: null });
            }
            return result;
        };
    }
}, 1000);

// Сетевой такт отправки состояния (Здоровье, голод, жажда, координаты)
setInterval(() => {
    if (isMultiplayerMode && socket && window.player) {
        socket.emit('player_update', {
            x: window.player.x,
            y: window.player.y,
            angle: window.player.angle,
            health: window.player.health,
            hunger: window.player.hunger,
            thirst: window.player.thirst,
            score: window.player.score,
            currentDimension: window.player.currentDimension || 'surface',
            onRaft: window.player.onRaft || false
        });
    }
}, 50);

// ИНЪЕКЦИЯ В ОРИГИНАЛЬНЫЙ ЦИКЛ ОТРИСОВКИ
const originalRAF = window.requestAnimationFrame;
window.requestAnimationFrame = function(callback) {
    let customCallback = callback;
    if (callback && callback.name === 'gameLoop') {
        customCallback = function(timestamp) {
            callback(timestamp); // Запуск отрисовки кадра из 130кб файла
            if (isMultiplayerMode && window.gameState === 'play') {
                renderRemotePlayers(); // Отрисовка других игроков поверх
            }
        };
    }
    return originalRAF(customCallback);
};

function renderRemotePlayers() {
    if (!window.ctx || !window.player) return;
    
    const ctx = window.ctx;
    const currentDim = window.player.currentDimension || 'surface';
    
    for (let id in remotePlayers) {
        const p = remotePlayers[id];
        if (p.currentDimension !== currentDim) continue;
        
        const screenX = p.x - window.camX + window.canvas.width / 2;
        const screenY = p.y - window.camY + window.canvas.height / 2;
        
        if (screenX < -60 || screenX > window.canvas.width + 60 || screenY < -60 || screenY > window.canvas.height + 60) {
            continue;
        }
        
        ctx.save();
        ctx.translate(screenX, screenY);
        
        if (p.onRaft) {
            ctx.fillStyle = '#78350f';
            ctx.fillRect(-24, -16, 48, 32);
            ctx.strokeStyle = '#451a03';
            ctx.lineWidth = 2;
            ctx.strokeRect(-24, -16, 48, 32);
        }
        
        ctx.rotate(p.angle);
        
        ctx.fillStyle = '#8b5cf6'; 
        ctx.beginPath();
        ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#a78bfa';
        ctx.beginPath();
        ctx.arc(16, -10, 6, 0, Math.PI * 2);
        ctx.arc(16, 10, 6, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.restore();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 4;
        ctx.fillText(`Survivor [${id.substring(0, 4)}]`, screenX, screenY - 38);
        ctx.shadowBlur = 0;
        
        ctx.fillStyle = '#333333';
        ctx.fillRect(screenX - 25, screenY - 30, 50, 5);
        const hpPercent = Math.max(0, Math.min(50, (p.health / 100) * 50));
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(screenX - 25, screenY - 30, hpPercent, 5);
    }
}

function showNotification(text) {
    if (window.showNotification) {
        window.showNotification(text);
    } else {
        const promptEl = document.getElementById('interactionPrompt');
        if (promptEl) {
            promptEl.innerText = text;
            promptEl.style.display = 'block';
            setTimeout(() => { promptEl.style.display = 'none'; }, 3000);
        }
    }
}