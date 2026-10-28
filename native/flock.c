#include <errno.h>
#include <sys/file.h>
#include <sys/stat.h>

/* The parent opens and validates the lock inode and passes its descriptor as 3.
 * flock is associated with the shared open file description on Darwin, just as
 * on Linux: helper exit leaves the parent's descriptor holding the lock. Never
 * explicitly unlock here. No path lookup, shell, or Node ABI is involved. */
int main(void) {
  struct stat info;
  if (fstat(3, &info) != 0 || !S_ISREG(info.st_mode) ||
      (info.st_mode & 0777) != 0600) return 1;
  if (flock(3, LOCK_EX | LOCK_NB) == 0) return 0;
  return errno == EWOULDBLOCK || errno == EAGAIN ? 75 : 1;
}
