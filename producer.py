import time
import json
import os
import requests
from datetime import datetime, timedelta
from confluent_kafka import Producer
from dotenv import load_dotenv

load_dotenv()  # .env dosyasından kimlik bilgilerini yükle

# Kafka ayarları
KAFKA_BROKER = os.environ.get('KAFKA_BROKER', 'localhost:9092')
TOPIC = 'flights'

# OpenSky OAuth2 client credentials
CLIENT_ID     = os.environ['OPENSKY_CLIENT_ID']
CLIENT_SECRET = os.environ['OPENSKY_CLIENT_SECRET']

TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)
TOKEN_REFRESH_MARGIN = 30  # token bitmeden kaç saniye önce yenile

# Kafka Producer ayarları
producer = Producer({'bootstrap.servers': KAFKA_BROKER})


class TokenManager:
    def __init__(self):
        self._token = None
        self._expires_at = None

    def get_token(self):
        if self._token and self._expires_at and datetime.now() < self._expires_at:
            return self._token
        return self._refresh()

    def _refresh(self):
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        expires_in = data.get("expires_in", 1800)
        self._expires_at = datetime.now() + timedelta(
            seconds=expires_in - TOKEN_REFRESH_MARGIN
        )
        print(f"✅ Token alındı, geçerlilik: {expires_in}s")
        return self._token

    def headers(self):
        return {"Authorization": f"Bearer {self.get_token()}"}


tokens = TokenManager()


def fetch_flight_data():
    # Türkiye bölgesi bounding box — 54 sq° → 2 kredi/istek
    url = (
        "https://opensky-network.org/api/states/all"
        "?lamin=36.0&lomin=26.0&lamax=42.0&lomax=45.0"
    )
    try:
        resp = requests.get(url, headers=tokens.headers(), timeout=15)
        if resp.status_code == 200:
            remaining = resp.headers.get("X-Rate-Limit-Remaining", "?")
            print(f"   Kalan kredi: {remaining}")
            return resp.json()
        elif resp.status_code == 429:
            retry_after = resp.headers.get("X-Rate-Limit-Retry-After-Seconds", "?")
            print(f"⚠️  Kredi bitti (429). {retry_after}s sonra tekrar dene.")
        elif resp.status_code == 401:
            print("🔑 Token süresi doldu, yenileniyor...")
            tokens._token = None
        else:
            print(f"API Hatası: HTTP {resp.status_code} — {resp.text[:120]}")
    except Exception as e:
        print(f"API Hatası: {e}")
    return None


print("Producer başlatıldı.")
print(f" Client ID: {CLIENT_ID}")

POLL_INTERVAL = 5  # saniye

while True:
    data = fetch_flight_data()
    if data and data.get("states"):
        flight_data_bytes = json.dumps(data["states"]).encode("utf-8")
        producer.produce(TOPIC, value=flight_data_bytes)
        producer.flush()
        print(f"✈️  {len(data['states'])} uçuş Kafka'ya gönderildi.")
    else:
        print(f"Veri alınamadı, {POLL_INTERVAL}s sonra tekrar deneniyor...")

    time.sleep(POLL_INTERVAL)
