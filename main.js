const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let serverStarted = false; // Флаг, чтобы не запустить сервер дважды

function createWindow () {
  const win = new BrowserWindow({
    width: 1020,
    height: 720,
    webPreferences: {
      nodeIntegration: true, 
      contextIsolation: false
    }
  });

  win.loadFile('index.html');
  // Откроем инструменты разработчика, чтобы видеть консоль и логи
  win.webContents.openDevTools(); 
}

// Слушаем сигнал "start-server" от интерфейса игры
ipcMain.on('start-server', (event) => {
  if (!serverStarted) {
    require('./server.js'); // Запускаем наш серверный код
    serverStarted = true;
    console.log('Основной процесс: Сервер запущен!');
  }
  event.reply('server-ready'); // Отвечаем клиенту, что всё готово
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});