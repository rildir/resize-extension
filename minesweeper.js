/**
 * PageEraser Chrome Extension — Minesweeper Easter Egg & Drag Helpers
 *
 * Implements the drag/drop modal wrapper and the custom classic Minesweeper game.
 */

function setupDraggableModal(modalEl, handleEl) {
  let mIsDragging = false;
  let mStartX = 0, mStartY = 0;
  let mCurrentX = 0, mCurrentY = 0;

  handleEl.addEventListener('mousedown', (e) => {
    mIsDragging = true;
    mStartX = e.clientX - mCurrentX;
    mStartY = e.clientY - mCurrentY;
    handleEl.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!mIsDragging) return;
    mCurrentX = e.clientX - mStartX;
    mCurrentY = e.clientY - mStartY;
    modalEl.style.transform = `translate(${mCurrentX}px, ${mCurrentY}px)`;
  });

  document.addEventListener('mouseup', () => {
    if (mIsDragging) {
      mIsDragging = false;
      handleEl.style.cursor = 'grab';
    }
  });

  handleEl.style.cursor = 'grab';
  
  return {
    reset() {
      mCurrentX = 0;
      mCurrentY = 0;
      modalEl.style.transform = '';
    }
  };
}

const MinesweeperGame = {
  overlay: null,
  modal: null,
  titleBar: null,
  closeBtn: null,
  grid: null,
  faceBtn: null,
  count: null,
  time: null,
  drag: null,
  
  board: [],
  mines: 10,
  rows: 8,
  cols: 8,
  gameStarted: false,
  gameOver: false,
  gameWon: false,
  timerInterval: null,
  timerSeconds: 0,
  remainingFlags: 10,

  init() {
    this.overlay = document.getElementById('minesweeper-overlay');
    this.modal = this.overlay.querySelector('.win-modal');
    this.titleBar = this.modal.querySelector('.title-bar');
    this.closeBtn = document.getElementById('btn-close-minesweeper');
    this.grid = document.getElementById('minesweeper-grid');
    this.faceBtn = document.getElementById('minesweeper-face-btn');
    this.count = document.getElementById('minesweeper-count');
    this.time = document.getElementById('minesweeper-time');

    this.drag = setupDraggableModal(this.modal, this.titleBar);

    this.closeBtn.addEventListener('click', () => this.hide());
    this.faceBtn.addEventListener('click', () => this.initBoard());

    // Easter egg trigger on retro screen click
    const eggScreen = document.getElementById('easter-egg-screen');
    if (eggScreen) {
      eggScreen.addEventListener('click', (e) => {
        e.stopPropagation();
        RetroAudio.playSelection();
        const aboutOverlay = document.getElementById('about-overlay');
        if (aboutOverlay) aboutOverlay.style.display = 'none';
        this.drag.reset();
        this.overlay.style.display = 'flex';
        this.initBoard();
      });
    }
  },

  hide() {
    this.stopTimer();
    this.overlay.style.display = 'none';
  },

  updateCounters() {
    let flagsStr = String(Math.abs(this.remainingFlags)).padStart(3, '0');
    if (this.remainingFlags < 0) {
      flagsStr = '-' + String(Math.abs(this.remainingFlags)).padStart(2, '0');
    }
    this.count.textContent = flagsStr;

    const timeStr = String(Math.min(this.timerSeconds, 999)).padStart(3, '0');
    this.time.textContent = timeStr;
  },

  startTimer() {
    this.stopTimer();
    this.timerSeconds = 0;
    this.updateCounters();
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      this.updateCounters();
      if (this.timerSeconds >= 999) {
        this.stopTimer();
      }
    }, 1000);
  },

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  },

  initBoard() {
    this.gameStarted = false;
    this.gameOver = false;
    this.gameWon = false;
    this.remainingFlags = this.mines;
    this.stopTimer();
    this.timerSeconds = 0;
    this.faceBtn.textContent = '🙂';
    this.updateCounters();

    this.board = [];
    this.grid.innerHTML = '';

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const index = r * this.cols + c;
        const cell = {
          index,
          row: r,
          col: c,
          isMine: false,
          isRevealed: false,
          isFlagged: false,
          neighborMines: 0,
          element: null
        };

        const cellEl = document.createElement('div');
        cellEl.className = 'mine-cell';
        cellEl.dataset.index = index;

        cellEl.addEventListener('click', (e) => {
          e.preventDefault();
          this.handleCellLeftClick(index);
        });

        cellEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.handleCellRightClick(index);
        });

        cell.element = cellEl;
        this.board.push(cell);
        this.grid.appendChild(cellEl);
      }
    }
  },

  generateMines(firstClickIndex) {
    let minesPlaced = 0;
    while (minesPlaced < this.mines) {
      const randIndex = Math.floor(Math.random() * (this.rows * this.cols));
      if (randIndex !== firstClickIndex && !this.board[randIndex].isMine) {
        this.board[randIndex].isMine = true;
        minesPlaced++;
      }
    }

    for (let i = 0; i < this.board.length; i++) {
      if (this.board[i].isMine) continue;
      let neighborsCount = 0;
      const neighbors = this.getCellNeighbors(this.board[i].row, this.board[i].col);
      neighbors.forEach(n => {
        if (n.isMine) neighborsCount++;
      });
      this.board[i].neighborMines = neighborsCount;
    }
  },

  getCellNeighbors(row, col) {
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
          list.push(this.board[nr * this.cols + nc]);
        }
      }
    }
    return list;
  },

  handleCellLeftClick(index) {
    if (this.gameOver || this.gameWon) return;
    const cell = this.board[index];
    if (cell.isRevealed || cell.isFlagged) return;

    if (!this.gameStarted) {
      this.gameStarted = true;
      this.generateMines(index);
      this.startTimer();
    }

    this.revealCell(index);
    this.checkWin();
  },

  revealCell(index) {
    const cell = this.board[index];
    cell.isRevealed = true;
    cell.element.classList.add('opened');

    if (cell.isMine) {
      this.triggerLoss(index);
      return;
    }

    RetroAudio.playMinesweeperClick();

    if (cell.neighborMines > 0) {
      cell.element.textContent = cell.neighborMines;
      cell.element.classList.add('num-' + cell.neighborMines);
    } else {
      const neighbors = this.getCellNeighbors(cell.row, cell.col);
      neighbors.forEach(n => {
        if (!n.isRevealed && !n.isFlagged && !n.isMine) {
          this.revealCell(n.index);
        }
      });
    }
  },

  handleCellRightClick(index) {
    if (this.gameOver || this.gameWon) return;
    const cell = this.board[index];
    if (cell.isRevealed) return;

    cell.isFlagged = !cell.isFlagged;
    if (cell.isFlagged) {
      cell.element.textContent = '🚩';
      this.remainingFlags--;
    } else {
      cell.element.textContent = '';
      this.remainingFlags++;
    }
    this.updateCounters();
  },

  triggerLoss(clickedMineIndex) {
    this.gameOver = true;
    this.stopTimer();
    this.faceBtn.textContent = '😵';
    RetroAudio.playMinesweeperExplosion();

    this.board.forEach(cell => {
      if (cell.isMine) {
        cell.element.classList.add('opened');
        if (cell.index === clickedMineIndex) {
          cell.element.classList.add('exploded');
        }
        cell.element.textContent = '💣';
      } else if (cell.isFlagged) {
        cell.element.textContent = '❌';
      }
    });
  },

  checkWin() {
    const win = this.board.every(cell => cell.isMine || cell.isRevealed);
    if (win) {
      this.gameWon = true;
      this.stopTimer();
      this.faceBtn.textContent = '😎';
      RetroAudio.playMinesweeperWin();

      this.board.forEach(cell => {
        if (cell.isMine && !cell.isFlagged) {
          cell.isFlagged = true;
          cell.element.textContent = '🚩';
        }
      });
      this.remainingFlags = 0;
      this.updateCounters();
    }
  }
};
