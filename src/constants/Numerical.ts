export namespace Numerical {
  export const MILLISECONDS_IN_A_SECOND = 1000;
  export const SECONDS_IN_A_MINUTE = 60;
  export const MINUTES_IN_AN_HOUR = 60;
  export const HOURS_IN_A_DAY = 24;
  export const DAYS_IN_A_WEEK = 7;
  export const SECONDS_IN_AN_HOUR = SECONDS_IN_A_MINUTE * MINUTES_IN_AN_HOUR;
  export const SECONDS_IN_A_DAY = SECONDS_IN_AN_HOUR * HOURS_IN_A_DAY;
  export const MILLISECONDS_IN_A_MINUTE = MILLISECONDS_IN_A_SECOND * SECONDS_IN_A_MINUTE;
  export const MILLISECONDS_IN_AN_HOUR = MILLISECONDS_IN_A_MINUTE * MINUTES_IN_AN_HOUR;
  export const MILLISECONDS_IN_A_DAY = MILLISECONDS_IN_AN_HOUR * HOURS_IN_A_DAY;
  
  export function secondsInXDays(days: number): number {
    throwIfNotInteger(days);
    return days * SECONDS_IN_A_DAY;
  }
  export function millisecondsInXDays(days: number): number {
    throwIfNotInteger(days);
    return days * MILLISECONDS_IN_A_DAY;
  }
  function throwIfNotInteger(value:number) {
    if (value !== parseInt(`${value}`)) {
      throw new Error("Invalid input: days must be an integer");
    }
  }
  
}