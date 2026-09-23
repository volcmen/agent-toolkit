//! Host overload policy. Use elapsed durations so stalls and recovery can be
//! tested without sleeping or relying on the machine's current load.
use std::collections::VecDeque;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Action {
    None,
    Throttle,
    Fallback,
}

#[derive(Default)]
pub struct RenderGuard {
    samples: VecDeque<(Duration, f32)>,
    over_since: Option<Duration>,
    severe_frames: u8,
    throttled: bool,
}

impl RenderGuard {
    pub fn observe(&mut self, now: Duration, cost: Duration, frame: Duration) -> Action {
        let cost = cost.as_secs_f32();
        let budget = frame.as_secs_f32();
        self.severe_frames = if cost > budget * 3.0 {
            self.severe_frames.saturating_add(1)
        } else {
            0
        };
        // A percentile of a short window can be a single scheduling or disk
        // stall. Require successive expensive frames before abandoning Lua.
        if self.severe_frames >= 3 {
            return Action::Fallback;
        }
        self.samples.push_back((now, cost));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| now.saturating_sub(*at) > Duration::from_secs(2))
        {
            self.samples.pop_front();
        }
        if self.samples.len() < 8 {
            return Action::None;
        }
        let mut values: Vec<_> = self.samples.iter().map(|(_, cost)| *cost).collect();
        values.sort_by(f32::total_cmp);
        let p95 = values[((values.len() - 1) as f32 * 0.95).round() as usize];
        if p95 > budget * 0.3 {
            let since = *self.over_since.get_or_insert(now);
            if !self.throttled && now.saturating_sub(since) >= Duration::from_secs(2) {
                self.throttled = true;
                return Action::Throttle;
            }
        } else {
            self.over_since = None;
        }
        Action::None
    }
}

#[derive(Default)]
pub struct Recovery {
    pub retry_at: Option<Duration>,
    failures: u32,
    healthy_since: Option<Duration>,
}

impl Recovery {
    pub fn defer(&mut self, now: Duration) -> Duration {
        let delay = Duration::from_secs((5u64 << self.failures.min(4)).min(60));
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(now + delay);
        self.healthy_since = None;
        delay
    }

    pub fn due(&self, now: Duration, enabled: bool, paused: bool) -> bool {
        enabled && !paused && self.retry_at.is_some_and(|at| now >= at)
    }

    pub fn healthy(&mut self, now: Duration) {
        self.retry_at = None;
        let since = *self.healthy_since.get_or_insert(now);
        if now.saturating_sub(since) >= Duration::from_secs(30) {
            self.failures = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn isolated_stalls_never_abandon_the_world() {
        for budget in [83, 167] {
            let mut guard = RenderGuard::default();
            for i in 0..240 {
                let cost = if i % 31 == 12 { 900 } else { 2 };
                assert_ne!(
                    guard.observe(ms(i * budget), ms(cost), ms(budget)),
                    Action::Fallback
                );
            }
        }
    }

    #[test]
    fn three_successive_expensive_frames_are_bounded_even_at_startup() {
        let mut guard = RenderGuard::default();
        assert_eq!(guard.observe(ms(900), ms(900), ms(167)), Action::None);
        assert_eq!(guard.observe(ms(1800), ms(900), ms(167)), Action::None);
        assert_eq!(guard.observe(ms(2700), ms(900), ms(167)), Action::Fallback);
    }

    #[test]
    fn sustained_moderate_cost_halves_rate_only_once() {
        let mut guard = RenderGuard::default();
        let mut throttles = 0;
        for i in 0..100 {
            match guard.observe(ms(i * 83), ms(30), ms(83)) {
                Action::Throttle => throttles += 1,
                Action::Fallback => panic!("moderate frames must not fall back"),
                Action::None => (),
            }
        }
        assert_eq!(throttles, 1);
    }

    #[test]
    fn retries_back_off_and_respect_pause_and_disable() {
        let mut recovery = Recovery::default();
        let mut now = Duration::ZERO;
        for secs in [5, 10, 20, 40, 60, 60] {
            let delay = recovery.defer(now);
            assert_eq!(delay, Duration::from_secs(secs));
            assert!(!recovery.due(now + delay - ms(1), true, false));
            now += delay;
            assert!(recovery.due(now, true, false));
            assert!(!recovery.due(now, false, false));
            assert!(!recovery.due(now, true, true));
            recovery.healthy(now);
        }
        recovery.healthy(now + Duration::from_secs(30));
        assert_eq!(recovery.defer(now), Duration::from_secs(5));
    }
}
