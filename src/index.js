const mqtt = require("mqtt");
const noble = require("@abandonware/noble");
const log = require("winston");

const log_level = process.env.LOG_LEVEL || "debug";

const rssi_update_interval = 15000; //in ms
const double_click_interval = 800; //in ms

const tag_device_name = "TAG-IT";
const mqtt_baseTopic = "itag";

const mqtt_url = process.env.MQTT_URL || "mqtt://localhost:1883";
const mqtt_config = {
  username: process.env.MQTT_USERNAME || "user",
  password: process.env.MQTT_PASSWORD || "password",
};

const itag_srv_btn = "ffe0";
const itag_srv_alert = "1802";
const itag_srv_linkLoss = "1803";
const itag_srv_batt = "180f";

const itag_chr_click = "ffe1";
const itag_chr_alertLevel = "2a06";
const itag_chr_batteryLevel = "2a19";

//https://googlechrome.github.io/samples/web-bluetooth/link-loss.html
const itag_chr_alert_off = 0x00; // ITAG no sound
const itag_chr_alert_cont = 0x01; // ITAG continous
const itag_chr_alert_beep = 0x02; // ITAG beeping

var start_time = Date.now();
var tags = {};

getITAGCharacteristic = (id, serviceId, characteristicID) => {
  peripheral = noble._peripherals[id];
  if (!peripheral) return;
  service = peripheral.services.find((srv) => srv.uuid === serviceId);
  if (!service) return;
  characteristic = service.characteristics.find(
    (charac) => charac.uuid === characteristicID
  );
  return characteristic;
};

alertITAGBeep = (id, ms) => {
  log.info(`ITAG peripheral id: ${id} beep ${ms}`);
  if (ms < 100 || ms > 600000) return;
  immediateAlertLevelCh = getITAGCharacteristic(
    peripheral.id,
    itag_srv_alert,
    itag_chr_alertLevel
  );
  immediateAlertLevelCh.write(new Buffer([itag_chr_alert_beep]), true, () => {
    setTimeout(() => {
      immediateAlertLevelCh.write(new Buffer([itag_chr_alert_off]), true);
    }, ms);
  });
};

alertITAGContinous = (id, ms) => {
  log.info(`ITAG peripheral id: ${id} continous ${ms}`);
  if (ms < 100 || ms > 600000) return;
  immediateAlertLevelCh = getITAGCharacteristic(
    peripheral.id,
    itag_srv_alert,
    itag_chr_alertLevel
  );
  immediateAlertLevelCh.write(new Buffer([itag_chr_alert_cont]), true, () => {
    setTimeout(() => {
      immediateAlertLevelCh.write(new Buffer([itag_chr_alert_off]), true);
    }, ms);
  });
};

onITAGButtonClicked = (peripheral) => {
  mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/button`, "pressed");
};

updateRSSI = (peripheral) => {
  peripheral.updateRssi(function (error, rssi) {
    var current_time = Date.now();
    var run_time = (current_time - start_time) / 1000;
    log.debug(
      `iTAG connected id: ${peripheral.id} name: ${peripheral.advertisement.localName} state: ${peripheral.state} rssi: ${rssi} at ${run_time}`
    );
    log.debug(
      `ITAG peripheral id: ${buttonCharacteristics} - Battery:${tags[peripheral.id]["battery"]
      }%`
    );
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/rssi`, `${rssi}`);
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/presence`, "1");
    mqttClient.publish(
      `${mqtt_baseTopic}/${peripheral.id}/battery`,
      `${tags[peripheral.id]["battery"]}`
    );
    if (tags[peripheral.id]["battery"] == null) {
      onITAGConnected(peripheral);
    }
  });
};

onITAGBatteryLevel = (peripheral, data) => {
  mqttClient.publish(
    `${mqtt_baseTopic}/${peripheral.id}/battery`,
    data.readUInt8(0).toString()
  );
};

onITAGConnected = (peripheral) => {
  // 300 ms delay due to ITAG disconnects on immediate service discovery
  setTimeout(() => {
    peripheral.discoverAllServicesAndCharacteristics(
      (error, services, characteristics) => {
        buttonCharacteristics = getITAGCharacteristic(
          peripheral.id,
          itag_srv_btn,
          itag_chr_click
        );
        buttonCharacteristics.on("data", (data, isNotification) => {
          log.info(`ITAG peripheral id: ${peripheral.id} Button Clicked`);
          onITAGButtonClicked(peripheral);
        });
        buttonCharacteristics.subscribe((error) => {
          if (error) log.error(error);
        });

        batteryCharacteristics = getITAGCharacteristic(
          peripheral.id,
          itag_srv_batt,
          itag_chr_batteryLevel
        );
        if (
          typeof batteryCharacteristics !== "undefined" &&
          batteryCharacteristics !== null
        ) {
          batteryCharacteristics.on("data", (data, isNotification) => {
            tags[peripheral.id]["battery"] = data.readUInt8(0);
            log.info(
              `ITAG peripheral id: ${peripheral.id} Battery Level = `,
              data.readUInt8(0) + `%`
            );
            onITAGBatteryLevel(peripheral, data);
          });
          batteryCharacteristics.subscribe((error) => {
            if (error) log.error(error);
          });
          batteryCharacteristics.read();
        }

        linkLossAlertLevelCh = getITAGCharacteristic(
          peripheral.id,
          itag_srv_linkLoss,
          itag_chr_alertLevel
        );

        if (
          typeof linkLossAlertLevelCh !== "undefined" &&
          linkLossAlertLevelCh !== null
        ) {
          linkLossAlertLevelCh.write(
            new Buffer([itag_chr_alert_off]),
            true,
            (error) => {
              if (error) log.error(error);
              log.debug(
                `ITAG peripheral id: ${peripheral.id} LinkLoss AlertLevel write success`
              );
            }
          );
        }
      }
    );
  }, 300);
};

connectITAG = (peripheral) => {
  log.info(`NOBLE peripheral id: ${peripheral.id} connecting`);

  peripheral.connect((error) => {
    if (error) {
      log.error(error);
      return;
    }
    onITAGConnected(peripheral);
  });

  peripheral.once("connect", () => {
    log.debug(`NOBLE peripheral id: ${peripheral.id} connected`);
    tags[peripheral.id] = {};
    tags[peripheral.id]["rssi_interval"] = setInterval(function () {
      updateRSSI(peripheral);
    }, rssi_update_interval);
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/presence`, "1");
    mqttClient.subscribe([
      `${mqtt_baseTopic}/${peripheral.id}/alert/continuous`,
      `${mqtt_baseTopic}/${peripheral.id}/alert/beep`,
    ]);
  });

  peripheral.once("disconnect", () => {
    log.warn(`NOBLE peripheral id: ${peripheral.id} disconnected`);
    clearTimeout(tags[peripheral.id]["rssi_interval"]);
    mqttClient.unsubscribe([
      `${mqtt_baseTopic}/${peripheral.id}/alert/continuous`,
      `${mqtt_baseTopic}/${peripheral.id}/alert/beep`,
    ]);
  });
};

startScanning = () => {
  noble.startScanning([], true);
}; // allow scanning duplicates

onNobleStateChange = (state) => {
  log.info(`NOBLE state: ${state}`);
  if (state === "poweredOn") {
    startScanning();
  }
};

onNobleScanStart = () => {
  log.info("NOBLE scanning started");
};

onNobleScanStop = () => {
  log.info("NOBLE scanning stopped");
  setTimeout(startScanning, 3000);
}; // noble stops scannig when trying to connect to a device

onNobleDiscover = (peripheral) => {
  log.debug(
    `NOBLE discovered id: ${peripheral.id} localName: ${peripheral.advertisement.localName} state: ${peripheral.state}`
  );
  var name = String(peripheral.advertisement.localName).trim().toUpperCase();
  if (name != tag_device_name) return;
  if (peripheral.state != "disconnected") return;
  connectITAG(peripheral);
};

onMqttMessage = (topic, message) => {
  log.debug("MQTT topic: " + topic + " message: " + message.toString());
  topicElements = topic.split("/");
  if (topicElements.length < 3 || isNaN(message.toString())) return;
  [tmp, tagId, cmd, type] = topicElements;
  if (cmd !== "alert") return;
  if (type != "beep") return;
  alertITAGBeep(tagId, parseInt(message.toString()));
};

onMqttConnect = () => {
  log.info("MQTT connected");
};

log.level = log_level;

const mqttClient = mqtt.connect(mqtt_url, mqtt_config);

mqttClient.on("connect", onMqttConnect);
mqttClient.on("message", onMqttMessage);

noble.on("stateChange", onNobleStateChange);
noble.on("scanStart", onNobleScanStart);
noble.on("scanStop", onNobleScanStop);
noble.on("discover", onNobleDiscover);
