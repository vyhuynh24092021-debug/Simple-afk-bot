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

  // Khi bot chết (vd: đói lâu quá không xử lý, bị mob đánh, rơi xuống...),
  // server sẽ gửi gói 'respawn' với respawn_position. Bedrock yêu cầu client
  // PHẢI gửi lại gói respawn xác nhận (client_request) thì mới được hồi sinh,
  // không tự động — nếu không gửi, bot sẽ treo ở màn hình chết.
  client.on('respawn', (packet) => {
    log('💀 Bot đã chết / nhận gói respawn từ server, đang xác nhận hồi sinh...')
    try {
      client.write('respawn', {
        position: packet.position,
        state: 'client_ready',
        runtime_entity_id: client.entity ? client.entity.runtimeEntityId : 0n
      })
      log('🔄 Đã gửi xác nhận respawn, bot sẽ hồi sinh tại điểm giường đã set.')
    } catch (e) {
      log('Không gửi được gói respawn:', e.message)
    }
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

  let jumpToggle = false

  // Bedrock client PHẢI gửi player_auth_input liên tục để báo "tôi vẫn ở đây" —
  // không gửi thì server không có gì để giữ chunk loaded quanh bot, và sau một
  // thời gian sẽ coi client là treo/timeout.
  //
  // QUAN TRỌNG: gói này KHÔNG dùng để "ép" server dịch chuyển bot tới toạ độ farm.
  // Server luôn validate vị trí dựa trên input di chuyển thực tế gửi lên; nếu bot
  // tự nhảy cóc toạ độ mà không có chuỗi input di chuyển hợp lý dẫn tới đó, gần như
  // chắc chắn server sẽ snap-back vị trí cũ hoặc kick vì coi là invalid movement.
  // => Vị trí farm phải đạt được bằng cách dắt bot tới đó 1 lần qua client thật
  // (server lưu last-position khi disconnect), bot ở đây chỉ giữ nguyên vị trí đó.
  moveTimer = setInterval(() => {
    // client.entity có thể chưa kịp khởi tạo ngay sau spawn — guard kỹ để tránh
    // crash toàn bộ process vì đọc property của undefined.
    if (!client || !client.entity || !client.entity.position) return

    try {
      jumpToggle = !jumpToggle
      const pos = client.entity.position

      client.queue('player_auth_input', {
        pitch: 0,
        yaw: 0,
        position: pos,
        move_vector: { x: 0, z: 0 },
        head_yaw: 0,
        // input_data phải là object chứa các cờ boolean, không phải array —
        // truyền sai kiểu sẽ khiến thư viện không encode được gói tin và crash.
        input_data: {
          forward: false,
          backward: false,
          left: false,
          right: false,
          jump_down: jumpToggle, // nhún nhẹ xen kẽ mỗi chu kỳ, vô hại, giúp tránh AFK-detect đơn giản
          sneak_down: false,
          asynchronous_input: true
        },
        input_mode: 'mouse',
        play_mode: 'normal',
        interact_rotation: { x: 0, y: 0 },
        tick: BigInt(Date.now()),
        delta: { x: 0, y: 0, z: 0 }
      })
      log(`🔄 Đã gửi tick giữ vị trí tại X:${pos.x?.toFixed?.(1)} Y:${pos.y?.toFixed?.(1)} Z:${pos.z?.toFixed?.(1)}`)
    } catch (e) {
      log('Không gửi được tick anti-AFK:', e.message)
    }
  }, (config.moveIntervalSeconds || 5) * 1000)
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
