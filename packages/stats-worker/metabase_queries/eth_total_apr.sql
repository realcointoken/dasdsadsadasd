select
  (((profit /( ((deposit_days_total-withdraw_days_total) / total) / 365.0)) / total) * 100) as apr
from (
  select
    (select (staked_amount - unstaked_amount) as total from bonder_balances where token = 'ETH' order by timestamp desc limit 1) as total,
    (select result3 from bonder_balances where token = 'ETH' order by timestamp desc limit 1) as profit,
    (
      select
        SUM(amount*days) as deposit_days_total
      from (
        select
          deposit_event as amount,
          julianday(datetime('now')) - julianday(strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'utc'))) as days
        from bonder_balances
        where
          deposit_event is not null
          and token = 'ETH'
          and strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'utc')) >= '2021-12-17'
      )
    ) as deposit_days_total,
    (
      select
        SUM(amount*days) as days_total
      from (
        select
          withdraw_event as amount,
          julianday(datetime('now')) - julianday(strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'utc'))) as days
        from bonder_balances
        where
          withdraw_event is not null
          and token = 'ETH'
          and strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'utc')) >= '2021-12-17'
      )
    ) as withdraw_days_total
)

