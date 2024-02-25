const functions = require("firebase-functions");
const rp = require("request-promise");
const secrets = require('./secrets');

// / number of weeks of events each invocation will create the calendar for
const NUMBER_OF_WEEKS = 4;

// / used as newline for calendar creation
const NEWLINE = "\r\n";

// / prefix that will precede the description of an assessment
const ASSESSMENT_PREFIX = "🙄";

// / used for calendar event creation
const EVENT_LOCATION = "";
const EVENT_DESCRIPTION = "";

// / alerts for assessments
const EVENT_ASSESSMENT_ALERTS = ["-P7D", "-P2D", "-P1D"];

/**
 * Scope that defines the content of the created calendar; the scope
 * can be passed as URL parameter using the `scope` key.
 *
 *   scope=LESSONS - create calendar with lessons only
 *   scope=ASSESSMENTS - create calendar with assessments only
 *   scope=ALL - create calendar with everything
 */
const CALENDAR_SCOPE_LESSONS = 1;
const CALENDAR_SCOPE_ASSESSMENTS = 2;
const CALENDAR_SCOPE_COMPLETE = (
  CALENDAR_SCOPE_LESSONS | CALENDAR_SCOPE_ASSESSMENTS);

/**
 * function used to pad date/time values to two digits
 * @param {Int} value The date/time value to be padded to two digits
 * @return {String} The two digit value with leading zero if required
 */
const padZero = (value) => (value < 10 ? `0${value}` : `${value}`);

/**
 * Builds the request parameters to obtain the schedule for the specified week
 * @param {Date} referenceDate The reference date of the week to be requested
 * @return {Object} The request parameters for the reference date
 */
function makeRequestOptions(referenceDate) {
  const year = referenceDate.getFullYear();
  const month = padZero(referenceDate.getMonth() + 1);
  const day = padZero(referenceDate.getDate());
  const date = `${year}-${month}-${day}`;

  const authToken = Buffer.from(
    secrets.userLogin + ":" + secrets.userPassword).toString("base64");

  return {
    uri: `${secrets.serverBaseURL}/${secrets.studentNumber}/${date}/Regular`,
    headers: {
      "User-Agent": "InovarAluno/20210804 CFNetwork/1492.0.1 Darwin/23.3.0",
      "Accept": "application/json",
      "Accept-Language": "en-us",
      "Authorization": `Basic ${authToken}`,
      "Accept-Encoding": "gzip, deflate, br",
    },
  };
}

/**
 * Maps the specified date from the JSON response to the expected
 * Calendar format
 * @param {Date} isoDateTimeString The date as received in the JSON response
 * @return {Object} The date in the Calendar format
 */
function makeCalendarDateTime(isoDateTimeString) {
  // 2024-02-27T10:20:00.0000000Z
  // TZID=Portugal/Lisbon:20240223T103400
  const date = new Date(isoDateTimeString);
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hour = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());
  return year + month + day + "T" + hour + minutes + "00";
}

/**
 * Maps the specified JSON event to the Calendar format
 * @param {Date} element The JSON event received from the service
 * @param {Int} calendarScope scope that defines the content of the calendar
 * @return {String} The event represented in the Calendar format
 */
function makeCalendarItem(element, calendarScope) {
  const isEvent = element.evento;
  if (isEvent && (calendarScope & CALENDAR_SCOPE_ASSESSMENTS) == 0) {
    return "";
  }
  if (!isEvent && (calendarScope & CALENDAR_SCOPE_LESSONS) == 0) {
    return "";
  }

  let eventName = element.descricao;
  if (isEvent) {
    eventName = ASSESSMENT_PREFIX + " " + eventName;
  }

  const startDate = makeCalendarDateTime(element.horaInicio);
  const endDate = makeCalendarDateTime(element.horaTermo);

  let result = "BEGIN:VEVENT";
  result = result + `${NEWLINE}SUMMARY:${eventName}`;
  result = result + `${NEWLINE}DTSTART;TZID=Portugal/Lisbon:${startDate}`;
  result = result + `${NEWLINE}DTEND;TZID=Portugal/Lisbon:${endDate}`;
  result = result + `${NEWLINE}LOCATION:${EVENT_LOCATION}`;
  result = result + `${NEWLINE}DESCRIPTION:${EVENT_DESCRIPTION}`;
  result = result + `${NEWLINE}STATUS:CONFIRMED`;
  result = result + `${NEWLINE}SEQUENCE:3`;

  if (isEvent) {
    EVENT_ASSESSMENT_ALERTS.forEach((alertTrigger) => {
      result = result + `${NEWLINE}BEGIN:VALARM`;
      result = result + `${NEWLINE}TRIGGER:${alertTrigger}`;
      result = result + `${NEWLINE}DESCRIPTION:${eventName}`;
      result = result + `${NEWLINE}ACTION:DISPLAY`;
      result = result + `${NEWLINE}END:VALARM`;
    });
  }

  result = result + `${NEWLINE}END:VEVENT`;
  return result;
}

/**
 * Requests the specified weeks from the service and returns the calendar
 * @param {Int} calendarScope scope that defines the content of the calendar
 * @return {Promise} The promise which handles the future
 */
function makeCalendar(calendarScope) {
  return new Promise(function (resolve, reject) {
    const promisesArray = [];
    const referenceDate = new Date();
    for (let index = 0; index < NUMBER_OF_WEEKS; index++) {
      promisesArray.push(rp(makeRequestOptions(referenceDate)));
      referenceDate.setDate(referenceDate.getDate() + 7);
    }

    Promise.all(promisesArray)
      .then((receivedWeeks) => {
        let calendar = "BEGIN:VCALENDAR";
        calendar = calendar + `${NEWLINE}VERSION:2.0`;
        calendar = calendar + `${NEWLINE}CALSCALE:GREGORIAN`;

        receivedWeeks.forEach((receivedWeek) => {
          const receivedWeekObject = JSON.parse(receivedWeek);
          receivedWeekObject.forEach((receivedEvent) => {
            calendar = (calendar +
              NEWLINE +
              makeCalendarItem(receivedEvent, calendarScope));
          });
        });

        calendar = calendar + `${NEWLINE}END:VCALENDAR`;
        resolve(calendar);
      })
      .catch(reject);
  });
}

exports.calendar = functions.https.onRequest((request, response) => {
  let calendarScope = CALENDAR_SCOPE_ASSESSMENTS;

  const requestedScope = (request.query.scope ?? "").toUpperCase();
  if (requestedScope == "LESSONS") {
    calendarScope = CALENDAR_SCOPE_LESSONS;
  } else if (requestedScope == "ASSESSMENTS") {
    calendarScope = CALENDAR_SCOPE_ASSESSMENTS;
  } else if ((requestedScope == "ALL") || (requestedScope == "COMPLETE")) {
    calendarScope = CALENDAR_SCOPE_COMPLETE;
  }

  functions.logger.info(`building calendar ${calendarScope}`);

  makeCalendar(calendarScope)
    .then(function (calendar) {
      response.send(calendar);
    })
    .catch(function (err) {
      functions.logger.error(`${err}\n${err.stack}`, { structuredData: true });
      response.send(`error scraping ${err}\n${err.stack}`);
    });
});
