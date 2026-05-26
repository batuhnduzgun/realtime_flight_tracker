import asyncio
import json
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from aiokafka import AIOKafkaConsumer

KAFKA_BROKER = os.environ.get('KAFKA_BROKER', 'localhost:9092')
TOPIC = 'flights'

# Her Kafka batch'i arası kaç adım interpolasyon yapılacak (OpenSky ~15s günceller)
INTERP_STEPS = 7        # 7 adım × 2s ≈ 14s
INTERP_INTERVAL = 2.0   # saniye

active_connections: set = set()

# Son iki Kafka batch'i (ICAO24 → uçuş listesi)
last_by_icao: dict = {}
curr_by_icao: dict = {}
interp_step: int = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(consume_kafka())
    asyncio.create_task(interpolation_broadcaster())
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def broadcast(text: str) -> None:
    if not active_connections:
        return
    snapshot = list(active_connections)
    results = await asyncio.gather(
        *[conn.send_text(text) for conn in snapshot],
        return_exceptions=True,
    )
    for conn, result in zip(snapshot, results):
        if isinstance(result, Exception):
            active_connections.discard(conn)


async def interpolation_broadcaster() -> None:
    """Son iki Kafka batch'i arasında her 2 saniyede ara konum gönderir.
    Bu sayede uçaklar 15 saniyede bir zıplamak yerine akıcı hareket eder."""
    global interp_step
    while True:
        await asyncio.sleep(INTERP_INTERVAL)
        if not curr_by_icao:
            continue

        interp_step = (interp_step + 1) % INTERP_STEPS
        t = interp_step / INTERP_STEPS   # 0.0 → ~0.86

        frames = []
        for icao24, curr in curr_by_icao.items():
            if icao24 in last_by_icao:
                prev = last_by_icao[icao24]
                try:
                    p_lat, p_lon = prev[6], prev[5]
                    c_lat, c_lon = curr[6], curr[5]
                    if None not in (p_lat, p_lon, c_lat, c_lon):
                        f = list(curr)
                        f[5] = p_lon + (c_lon - p_lon) * t
                        f[6] = p_lat + (c_lat - p_lat) * t
                        frames.append(f)
                        continue
                except Exception:
                    pass
            frames.append(list(curr))

        if frames:
            await broadcast(json.dumps(frames))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    print(f"Yeni istemci bağlandı. Toplam: {len(active_connections)}")

    # Yeni bağlantıya anında son bilinen durumu gönder —
    # böylece backend yeniden başladıktan sonra bağlanan client
    # 15 saniye beklemeden veriyi hemen görür.
    if curr_by_icao:
        try:
            snapshot = json.dumps(list(curr_by_icao.values()))
            await websocket.send_text(snapshot)
        except Exception:
            active_connections.discard(websocket)
            return

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.discard(websocket)
        print(f"İstemci ayrıldı. Kalan: {len(active_connections)}")


async def consume_kafka() -> None:
    global last_by_icao, curr_by_icao, interp_step
    while True:
        consumer = AIOKafkaConsumer(
            TOPIC,
            bootstrap_servers=KAFKA_BROKER,
            group_id='flight-tracker-group',
            auto_offset_reset='latest',
        )
        try:
            await consumer.start()
            print("Kafka Consumer başarıyla başlatıldı, veriler bekleniyor...")
            async for msg in consumer:
                raw = msg.value.decode('utf-8')
                flights = json.loads(raw)

                # Batch'leri güncelle ve interpolasyon sayacını sıfırla
                last_by_icao = dict(curr_by_icao)
                curr_by_icao = {f[0]: f for f in flights if f[0]}
                interp_step = 0

                await broadcast(raw)
        except Exception as e:
            print(f"Consumer Hatası: {e}, 5 saniye sonra yeniden bağlanılacak...")
        finally:
            await consumer.stop()
        await asyncio.sleep(5)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)