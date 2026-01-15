//! 提供稳定的 API 供 Rust crate 与 Android 平台交互。
//!
//! 上游 ndk-context 0.1.1 假设初始化只会发生一次，并用断言强制：
//! `assert!(previous.is_none())`。
//!
//! 现实是：部分厂商系统/生命周期路径可能在同一进程里触发二次 create，
//! 导致重复初始化从而直接 abort（我们 release profile 是 `panic = "abort"`）。
//! 这里把初始化/释放改成幂等：重复调用不再崩溃，后一次会覆盖前一次。

use std::ffi::c_void;

static mut ANDROID_CONTEXT: Option<AndroidContext> = None;

/// [`AndroidContext`] 提供在 Android 上与 JNI 交互所需的指针。
#[derive(Clone, Copy, Debug)]
pub struct AndroidContext {
    java_vm: *mut c_void,
    context_jobject: *mut c_void,
}

impl AndroidContext {
    /// `JavaVM` 句柄。
    pub fn vm(self) -> *mut c_void {
        self.java_vm
    }

    /// [`android.content.Context`](https://developer.android.com/reference/android/content/Context) 句柄。
    ///
    /// 大多数情况下是 `Activity`，但并不保证。
    pub fn context(self) -> *mut c_void {
        self.context_jobject
    }
}

/// 主入口：返回 [`AndroidContext`]。
pub fn android_context() -> AndroidContext {
    unsafe { ANDROID_CONTEXT.expect("android context was not initialized") }
}

/// 初始化 [`AndroidContext`]。
///
/// # Safety
///
/// 指针必须有效。
///
/// 说明：上游要求“只调用一次”；这里放宽为幂等以避免厂商系统二次初始化导致崩溃。
pub unsafe fn initialize_android_context(java_vm: *mut c_void, context_jobject: *mut c_void) {
    let next = AndroidContext {
        java_vm,
        context_jobject,
    };

    match ANDROID_CONTEXT {
        None => {
            ANDROID_CONTEXT = Some(next);
        }
        Some(prev) => {
            // 若重复传入同一对指针，直接返回。
            if prev.java_vm == next.java_vm && prev.context_jobject == next.context_jobject {
                return;
            }
            // 否则用最新值覆盖，避免后续使用到已失效的 Context 指针。
            ANDROID_CONTEXT = Some(next);
        }
    }
}

/// 释放 [`AndroidContext`]。
///
/// # Safety
///
/// 说明：上游在未初始化时会断言崩溃；这里改为幂等，允许重复释放而不崩溃。
pub unsafe fn release_android_context() {
    ANDROID_CONTEXT = None;
}
