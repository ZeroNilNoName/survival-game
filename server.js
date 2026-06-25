const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(__dirname));

const globalPlayers = {};
const globalWorldModifications = {};
const globalFloorItems = [];
const globalAnimals = [];

const globalSeed = Math.floor(Math.random() * 100000);

// --- ЛОГИКА ШУМА И БИОМОВ ДЛЯ СЕРВЕРА ---
function MathNoise2D(x, y) { let n = Math.sin(x * 12.9898 + y * 78.233 + globalSeed) * 43758.5453123; return n - Math.floor(n); }
function smoothNoise2D(x, y) { let cx = Math.floor(x), cy = Math.floor(y), fx = x - cx, fy = y - cy; let ux = fx * fx * (3.0 - 2.0 * fx), uy = fy * fy * (3.0 - 2.0 * fy); let v00 = MathNoise2D(cx, cy), v10 = MathNoise2D(cx + 1, cy), v01 = MathNoise2D(cx, cy + 1), v11 = MathNoise2D(cx + 1, cy + 1); return v00 * (1 - ux) * (1 - uy) + v10 * ux * (1 - uy) + v01 * (1 - ux) * uy + v11 * ux * uy; }
function fbm2D(x, y, octaves = 3) { let value = 0, amplitude = 1.0, frequency = 1.0, maxVal = 0; for(let i=0; i<octaves; i++) { value += amplitude * smoothNoise2D(x * frequency, y * frequency); maxVal += amplitude; amplitude *= 0.5; frequency *= 2.0; } return value / maxVal; }
const BIOMES = { SEA: 'SEA', RIVER: 'RIVER', BEACH_SAND: 'BEACH_SAND', BEACH_CLAY: 'BEACH_CLAY', DESERT: 'DESERT', STEPPE: 'STEPPE', PLAIN: 'PLAIN', FOREST: 'FOREST', TAIGA: 'TAIGA', TUNDRA: 'TUNDRA' };
function getBiomeAt(tileX, tileY) {
    let elevation = fbm2D(tileX * 0.02, tileY * 0.02, 4); let temperature = fbm2D(tileX * 0.015 + 200, tileY * 0.015 + 200, 3); let moisture = fbm2D(tileX * 0.02 + 400, tileY * 0.02 + 400, 3);
    if (elevation < 0.38) return BIOMES.SEA; let riverPattern = Math.abs(Math.sin(fbm2D(tileX * 0.05 + 600, tileY * 0.05 + 600, 2) * Math.PI)); if (riverPattern < 0.12) return BIOMES.RIVER;
    if (elevation < 0.42) { let beachNoise = fbm2D(tileX * 0.1 + 1000, tileY * 0.1 + 1000, 2); return beachNoise > 0.5 ? BIOMES.BEACH_SAND : BIOMES.BEACH_CLAY; }
    if (temperature < 0.35) return (moisture < 0.45) ? BIOMES.TUNDRA : BIOMES.TAIGA; 
    else if (temperature < 0.65) { if (moisture < 0.35) return BIOMES.STEPPE; return (moisture < 0.65) ? BIOMES.PLAIN : BIOMES.FOREST; } 
    else { if (moisture < 0.35) return BIOMES.DESERT; return (moisture < 0.60) ? BIOMES.STEPPE : BIOMES.PLAIN; }
}

function getDropsForFeature(feature, tx, ty) {
    const cx = tx * 64 + 32, cy = ty * 64 + 32;
    const drops = [];
    if (feature.type === 'tree') { drops.push({ name: 'log', count: Math.floor(Math.random() * 3) + 1 }); if (Math.random() < 0.25) drops.push({ name: 'stick', count: 1 }); }
    else if (feature.type === 'stone') { drops.push({ name: 'rock', count: 3 }); }
    else if (feature.type === 'coal_ore') { drops.push({ name: 'coal', count: 1 }); }
    else if (feature.type === 'copper_ore') { drops.push({ name: 'copper ore', count: 1 }); }
    else if (feature.type === 'tin_ore') { drops.push({ name: 'tin ore', count: 1 }); }
    else if (feature.type === 'iron_ore') { drops.push({ name: 'iron ore', count: 1 }); }
    else if (feature.type === 'sulfur_ore') { drops.push({ name: 'sulfur', count: 1 }); }
    else if (feature.type === 'placed_log') { drops.push({ name: 'log', count: 1 }); }
    else if (feature.type === 'door') { drops.push({ name: 'log', count: 2 }); }
    else if (feature.type === 'brick_wall') { drops.push({ name: 'brick wall', count: 1 }); }
    else if (feature.type === 'loom') { drops.push({ name: 'loom', count: 1 }); }
    else if (feature.type === 'bed') { drops.push({ name: 'bed', count: 1 }); }
    else if (feature.type === 'bush') { drops.push({ name: 'stick', count: Math.floor(Math.random() * 3) + 1 }); if (Math.random() < 0.20) drops.push({ name: 'wildberries', count: 1 }); }
    else if (feature.type === 'seaweed_plant') { drops.push({ name: 'seaweed', count: 1 }); }
    return drops.map(d => ({ ...d, x: cx + (Math.random() - 0.5) * 20, y: cy + (Math.random() - 0.5) * 20 }));
}

function getDropsForAnimal(type) {
    const drops = [];
    if (type === 'pig') { drops.push({ name: 'hide', count: 1 }); drops.push({ name: 'meat', count: Math.floor(Math.random() * 3) + 1 }); if (Math.random() < 0.5) drops.push({ name: 'fat', count: 1 }); }
    else if (type === 'sheep') { drops.push({ name: 'hide', count: 1 }); drops.push({ name: 'meat', count: Math.floor(Math.random() * 2) + 1 }); drops.push({ name: 'wool', count: 1 }); }
    else if (type === 'deer') { drops.push({ name: 'hide', count: Math.floor(Math.random() * 2) + 1 }); drops.push({ name: 'meat', count: Math.floor(Math.random() * 3) + 2 }); drops.push({ name: 'sinew', count: 1 }); }
    else if (type === 'wolf') { drops.push({ name: 'hide', count: 1 }); }
    return drops;
}

function spawnServerItem(wx, wy, name, count, dim = 'surface') {
    const item = { id: Math.random().toString(36).substr(2, 9), x: wx, y: wy, name, count, dim };
    globalFloorItems.push(item);
    io.emit('item_spawned', item);
}

function generateServerFloorItems(tx, ty, biome, dim) {
    if (dim === 'cave') return;
    let rand = MathNoise2D(tx, ty);
    const cx = tx * 64 + 32, cy = ty * 64 + 32;
    
    if (biome === 'FOREST' || biome === 'TAIGA') {
        if (rand >= 0.08 && rand < 0.095) spawnServerItem(cx, cy, 'stick', 1, dim);
        else if (rand >= 0.095 && rand < 0.105) spawnServerItem(cx, cy, 'apple', 1, dim);
        if (biome === 'TAIGA' && rand > 0.85 && rand < 0.88) spawnServerItem(cx + 8, cy + 8, 'wildberries', 1, dim);
        if (biome === 'FOREST' && rand > 0.90 && rand < 0.92) spawnServerItem(cx + 8, cy + 8, 'carrot', 1, dim);
    } 
    else if (biome === 'PLAIN' || biome === 'STEPPE' || biome === 'DESERT') {
        if (rand >= 0.04 && rand < 0.055 && biome !== 'DESERT') spawnServerItem(cx, cy, 'rock', 1, dim);
        if (rand > 0.93 && rand < 0.95) spawnServerItem(cx + 8, cy + 8, 'carrot', 1, dim);
    } 
    else if (biome === 'TUNDRA') {
        if (rand > 0.85 && rand < 0.88) spawnServerItem(cx + 8, cy + 8, 'wildberries', 1, dim);
    }
}

function spawnServerAnimal(tx, ty, type, count) {
    for(let i=0; i<count; i++) {
        let maxH = 50; if (type === 'sheep') maxH = 40; if (type === 'deer') maxH = 100; if (type === 'wolf') maxH = 60;
        const animal = { 
            id: Math.random().toString(36).substr(2, 9), 
            x: tx * 64 + (Math.random() - 0.5) * 64 * 2, 
            y: ty * 64 + (Math.random() - 0.5) * 64 * 2, 
            type, health: maxH, maxHealth: maxH, state: 'wander', 
            targetX: 0, targetY: 0, wanderTime: 0, attackCooldown: 0, 
            fleeTime: 0, dim: 'surface', angle: 0 // НОВОЕ: Добавлен угол
        };
        globalAnimals.push(animal);
    }
}

io.on('connection', (socket) => {
    console.log(`[JOIN] ${socket.id}`);
    globalPlayers[socket.id] = { id: socket.id, x: 0, y: 0, angle: 0, health: 100, hunger: 100, thirst: 100, score: 0, currentDimension: 'surface', onRaft: false, nickname: 'Survivor' };

    socket.emit('init_world', { players: globalPlayers, worldModifications: globalWorldModifications, seed: globalSeed, floorItems: globalFloorItems, animals: globalAnimals });
    socket.broadcast.emit('player_joined', globalPlayers[socket.id]);

    socket.on('player_update', (data) => { if (globalPlayers[socket.id]) { Object.assign(globalPlayers[socket.id], data); socket.broadcast.emit('player_updated', globalPlayers[socket.id]); } });

    socket.on('tile_modify', (data) => {
        const { key, value } = data;
        const oldFeature = globalWorldModifications[key];
        if (value === null) {
            if (oldFeature && oldFeature.type) {
                const parts = key.split('_'); const [tx, ty] = parts[1].split(',').map(Number);
                const drops = getDropsForFeature(oldFeature, tx, ty);
                drops.forEach(d => spawnServerItem(d.x, d.y, d.name, d.count));
            }
            globalWorldModifications[key] = null;
        } else {
            if (!globalWorldModifications[key]) {
                const parts = key.split('_');
                const dim = parts[0];
                const [tx, ty] = parts[1].split(',').map(Number);
                const biome = getBiomeAt(tx, ty);
                generateServerFloorItems(tx, ty, biome, dim);
            }
            globalWorldModifications[key] = value;
        }
        socket.broadcast.emit('tile_modified', data);
    });

    socket.on('pickup_item', (itemId) => {
        const itemIndex = globalFloorItems.findIndex(i => i.id === itemId);
        if (itemIndex !== -1) {
            const item = globalFloorItems[itemIndex];
            const player = globalPlayers[socket.id];
            if (player) {
                const dist = Math.hypot(player.x - item.x, player.y - item.y);
                if (dist < 200) {
                    globalFloorItems.splice(itemIndex, 1);
                    io.emit('item_picked_up', { id: itemId, playerId: socket.id, item: { name: item.name, count: item.count } });
                }
            }
        }
    });

    socket.on('damage_animal', (data) => {
        const animal = globalAnimals.find(a => a.id === data.id);
        if (animal) {
            animal.health -= data.damage;
            animal.fleeTime = 5; animal.state = 'flee';
            if (animal.health <= 0) {
                globalAnimals.splice(globalAnimals.indexOf(animal), 1);
                io.emit('animal_killed', { id: animal.id });
                const drops = getDropsForAnimal(animal.type);
                drops.forEach(d => spawnServerItem(animal.x, animal.y, d.name, d.count));
            }
        }
    });

    socket.on('damage_player', (data) => {
        if (globalPlayers[data.targetId]) {
            globalPlayers[data.targetId].health -= data.damage;
            io.emit('player_damaged', { id: data.targetId, health: globalPlayers[data.targetId].health });
        }
    });

    socket.on('give_item', (data) => {
        io.to(data.targetId).emit('receive_item', { fromId: socket.id, item: data.item });
    });

    socket.on('disconnect', () => { delete globalPlayers[socket.id]; io.emit('player_left', socket.id); });
});

let lastTime = Date.now();
setInterval(() => {
    let now = Date.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;

    if (Math.random() < 0.2 && globalAnimals.length < 25) {
        const playerIds = Object.keys(globalPlayers);
        if (playerIds.length > 0) {
            const p = globalPlayers[playerIds[Math.floor(Math.random() * playerIds.length)]];
            let spawnAngle = Math.random() * Math.PI * 2; let spawnDist = 800 + Math.random() * 400;
            let sx = p.x + Math.cos(spawnAngle) * spawnDist; let sy = p.y + Math.sin(spawnAngle) * spawnDist;
            let stx = Math.floor(sx / 64); let sty = Math.floor(sy / 64);
            let bio = getBiomeAt(stx, sty);
            if (bio !== BIOMES.SEA && bio !== BIOMES.RIVER) {
                let rand = Math.random(); let groupSize = Math.floor(Math.random() * 5) + 1;
                if (bio === BIOMES.FOREST || bio === BIOMES.TAIGA) { if (rand < 0.3) spawnServerAnimal(stx, sty, 'wolf', Math.random() > 0.5 ? groupSize : 1); else if (rand < 0.6) spawnServerAnimal(stx, sty, 'deer', groupSize); else spawnServerAnimal(stx, sty, 'pig', groupSize); }
                else if (bio === BIOMES.PLAIN) { if (rand < 0.2) spawnServerAnimal(stx, sty, 'wolf', groupSize); else if (rand < 0.5) spawnServerAnimal(stx, sty, 'sheep', groupSize); else spawnServerAnimal(stx, sty, 'pig', groupSize); }
                else if (bio === BIOMES.STEPPE) { if (rand < 0.2) spawnServerAnimal(stx, sty, 'wolf', groupSize); else if (rand < 0.6) spawnServerAnimal(stx, sty, 'sheep', groupSize); else spawnServerAnimal(stx, sty, 'deer', groupSize); }
            }
        }
    }

    for (let i = globalAnimals.length - 1; i >= 0; i--) {
        let a = globalAnimals[i];
        let nearestPlayer = null; let minDist = Infinity;
        for (let id in globalPlayers) { let p = globalPlayers[id]; if (p.currentDimension !== a.dim) continue; let d = Math.hypot(p.x - a.x, p.y - a.y); if (d < minDist) { minDist = d; nearestPlayer = p; } }

        if (nearestPlayer) {
            let dx = nearestPlayer.x - a.x; let dy = nearestPlayer.y - a.y; let dist = Math.hypot(dx, dy);
            if (dist > 1500) { globalAnimals.splice(i, 1); continue; }
            if (dist < 0.1) dist = 0.1;
            a.attackCooldown = Math.max(0, a.attackCooldown - dt);
            a.fleeTime = Math.max(0, a.fleeTime - dt);
            if (a.type === 'wolf') { if (dist < 250) a.state = 'chase'; else if (dist > 400) a.state = 'wander'; } else { if (a.fleeTime > 0) a.state = 'flee'; else a.state = 'wander'; }
            
            // НОВОЕ: Обновление угла поворота животного
            if (a.state === 'chase') { 
                let nx = dx / dist, ny = dy / dist; a.x += nx * 65 * dt; a.y += ny * 65 * dt; 
                a.angle = Math.atan2(ny, nx); 
                if (dist < 45 && a.attackCooldown === 0) { a.attackCooldown = 1.5; io.emit('animal_attack', { animalId: a.id, playerId: nearestPlayer.id }); } 
            }
            else if (a.state === 'flee') { 
                let nx = -dx / dist, ny = -dy / dist; a.x += nx * 80 * dt; a.y += ny * 80 * dt; 
                a.angle = Math.atan2(ny, nx); 
            }
            else if (a.state === 'wander') { 
                a.wanderTime -= dt; 
                if (a.wanderTime <= 0) { a.wanderTime = 2 + Math.random() * 3; a.targetX = a.x + (Math.random() - 0.5) * 200; a.targetY = a.y + (Math.random() - 0.5) * 200; } 
                let wdx = a.targetX - a.x, wdy = a.targetY - a.y, wdist = Math.hypot(wdx, wdy); 
                if (wdist > 5) { 
                    let spd = a.type === 'deer' ? 40 : 25; 
                    let nx = wdx / wdist, ny = wdy / wdist; 
                    a.x += nx * spd * dt; a.y += ny * spd * dt; 
                    a.angle = Math.atan2(ny, nx); 
                } 
            }
        }
    }
    io.emit('animals_sync', globalAnimals);
}, 100);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на ${PORT}`));