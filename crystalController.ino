#include <WiFi.h>
#include <HTTPClient.h>
#include <U8g2lib.h>

// ===== CONFIG =====
const char* WIFI_SSID = "FF2026"; 
const char* WIFI_PASS = "1111100000"; 
const char* SERVER_URL = "http://192.168.8.142:3000/event"; // Pi endpoint 

// Safe GPIOs for 7 switches (avoid 0,5,6,8)
const int switchPins[7] = {1, 2, 3, 4, 7, 9, 10};

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE, 6, 5);

bool slotState[7] = {false};     // current physical state
bool lastSlotState[7] = {false}; // previous loop state
bool pendingStateSync = false;   // send full state on next retry

int crystalCount = 0;
bool wifiConnected = false;
unsigned long lastWifiCheck = 0;

// ===== SETUP =====
void setup()
{
  // Initialize switches
  for (int i = 0; i < 7; i++)
    pinMode(switchPins[i], INPUT_PULLUP);

  // Initialize OLED
  u8g2.begin();
  u8g2.setContrast(255);
  drawStatus("Booting...", crystalCount);

  // Connect to Wi-Fi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ===== LOOP =====
void loop()
{
  checkWifi();

  // Read switches and update count dynamically
  crystalCount = 0;
  for (int i = 0; i < 7; i++)
  {
    slotState[i] = (digitalRead(switchPins[i]) == LOW); // pressed = LOW

    if (slotState[i] != lastSlotState[i])
      pendingStateSync = true; // any change: send full state

    lastSlotState[i] = slotState[i];

    if (slotState[i])
      crystalCount++;
  }

  drawStatus("Live Count", crystalCount);

  // Attempt to send pending events
  if (wifiConnected)
    retryPending();

  delay(50); // small debounce + CPU relief
}

// ===== WIFI CHECK =====
void checkWifi()
{
  if (millis() - lastWifiCheck < 2000)
    return;
  lastWifiCheck = millis();

  wifiConnected = (WiFi.status() == WL_CONNECTED);
}

// ===== SEND EVENTS =====
void retryPending()
{
  if (!pendingStateSync)
    return;
  if (sendCrystalEvent())
    pendingStateSync = false;
}

bool sendCrystalEvent()
{
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  // Full state: type, slots array [true/false...], count
  String slotsJson = "[";
  for (int i = 0; i < 7; i++)
  {
    if (i > 0) slotsJson += ",";
    slotsJson += slotState[i] ? "true" : "false";
  }
  slotsJson += "]";
  String payload = "{ \"type\": \"crystal\", \"slots\": " + slotsJson + ", \"count\": " + String(crystalCount) + " }";
  int code = http.POST(payload);
  http.end();

  // Show result briefly: 200 = OK, -1 = connection failed, other = HTTP error
  if (code == 200)
  {
    drawStatus("Sent", crystalCount);
  }
  else
  {
    String errMsg = "Err " + String(code);
    drawStatus(errMsg.c_str(), crystalCount);
  }
  return (code == 200);
}

// ===== OLED DISPLAY =====
void drawStatus(const char *status, int count)
{
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_7x13_tr);

  // Use the status argument here
  String line = String(status) + " " + String(count);
  u8g2.drawStr(2, 12, line.c_str());

  u8g2.drawStr(2, 25, ("WiFi: " + String(wifiConnected ? "ON" : "OFF")).c_str());

  u8g2.sendBuffer();
}