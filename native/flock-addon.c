#include <errno.h>
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>

static napi_value lock(napi_env env, napi_callback_info callback) {
  size_t argc = 1;
  napi_value argument;
  int32_t fd;
  struct stat info;
  const char *status = "error";
  if (napi_get_cb_info(env, callback, &argc, &argument, NULL, NULL) == napi_ok &&
      argc == 1 && napi_get_value_int32(env, argument, &fd) == napi_ok &&
      fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
      (info.st_mode & 0777) == 0600) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) status = "ok";
    else if (errno == EWOULDBLOCK || errno == EAGAIN) status = "busy";
  }
  napi_value result;
  if (napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &result) != napi_ok)
    return NULL;
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "lock", NAPI_AUTO_LENGTH, lock, NULL, &function) !=
          napi_ok ||
      napi_set_named_property(env, exports, "lock", function) != napi_ok)
    return NULL;
  return exports;
}
