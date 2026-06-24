/**
 * AFK Bot cho Minecraft Bedrock - giữ chunk loaded
 * Chạy: node bot.js
 *
 * Cấu hình trong config.json:
 *  - host, port: địa chỉ server
 *  - username: tên hiển thị trong server
 *  - offline: true nếu server không cần Xbox Live auth (đa số server riêng để offline=true)
 *  - version: version protocol Bedrock, phải khớp với server (ví dụ "1.21.0")
 *  - moveIntervalSeconds: bao lâu thì bot nhún nhẹ 1 lần để tránh bị coi là AFK
 *  - reconnectDelaySeconds: chờ bao lâu trước khi tự kết nối lại nếu rớt mạng
 */

const fs = require('fs')
const path = require('path')
const bedrock = require('bedrock-protocol')

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))

let client = null
let moveTimer = null
let reconnecting = false
let failCount = 0

function log(...args) {
  const time = new Date().toLocaleTimeString('vi-VN')
  console.log(`[${time}]`, ...args)
}

function connect() {
  log(`Đang kết nối tới ${config.host}:${config.port} với tên "${config.username}"... (lần thử #${failCount + 1})`)

  client = bedrock.createClient({
    host: config.host,
    port: config.port,
    username: config.username,
    offline: config.offline,
    version: config.version
  })

  client.on('join', () => {
    log('Đã join server (đang chờ spawn)...')
  })

  client.on('spawn', () => {
    log('✅ Bot đã spawn thành công. Đang giữ chunk loaded...')
    failCount = 0
    startAntiAfkLoop()
  })

  client.on('disconnect', (packet) => {
    log('❌ Bị server disconnect:', packet && packet.message ? packet.message : packet)
    cleanupAndReconnect()
  })

  client.on('kick', (reason) => {
    log('❌ Bị kick:', reason)
    cleanupAndReconnect()
  })

  client.on('error', (err) => {
    log('⚠️ Lỗi kết nối:', err.message || err)
    cleanupAndReconnect()
  })

  client.on('close', () => {
    log('Kết nối đã đóng.')
    cleanupAndReconnect()
  })
}

function startAntiAfkLoop() {
  if (moveTimer) clearInterval(moveTimer)

  moveTimer = setInterval(() => {
    if (!client || !client.entityId) return
    try {
      // Gửi gói player_action kiểu "swing arm" / nhún nhẹ để báo hiệu còn hoạt động
      // Đây là động tác tối thiểu, không di chuyển vị trí, không phá block
      client.queue('interact', {
        action_id: 'mouse_over_entity',
        target_entity_id: 0n,
        position: { x: 0, y: 0, z: 0 }
      })
      log('🔄 Đã gửi tín hiệu giữ trạng thái hoạt động (anti-AFK ping).')
    } catch (e) {
      log('Không gửi được tín hiệu anti-AFK:', e.message)
    }
  }, (config.moveIntervalSeconds || 60) * 1000)
}

function cleanupAndReconnect() {
  if (reconnecting) return
  reconnecting = true
  failCount++

  if (moveTimer) {
    clearInterval(moveTimer)
    moveTimer = null
  }

  const baseDelay = (config.reconnectDelaySeconds || 10) * 1000
  // Backoff nhẹ: tăng dần theo số lần fail liên tiếp, tối đa 60s,
  // để không spam liên tục khi server tắt hẳn lâu, nhưng vẫn đủ nhanh
  // để bắt được lúc server vừa lên lại.
  const delay = Math.min(baseDelay * Math.min(failCount, 6), 60000)

  log(`Server chưa sẵn sàng hoặc rớt kết nối (lần fail #${failCount}). Thử lại sau ${delay / 1000}s...`)

  setTimeout(() => {
    reconnecting = false
    connect()
  }, delay)
}

process.on('SIGINT', () => {
  log('Đang dừng bot...')
  if (moveTimer) clearInterval(moveTimer)
  if (client) client.close()
  process.exit(0)
})

connect()
