from sqlalchemy import Column, Integer, String, Float
from database import Base

class Flight(Base):
    __tablename__ = "flights"

    id = Column(Integer, primary_key=True, index=True)
    flight = Column(String)
    airline = Column(String)
    run_type = Column(String)
    arrival = Column(String)
    date = Column(String)
    station = Column(String)

    status_text = Column(String)
    terminal = Column(String)
    gate = Column(String)
    baggage = Column(String)
    aircraft = Column(String)
    eta = Column(String)
    accuracy = Column(String)

    origin_lat = Column(Float)
    origin_lng = Column(Float)
    dest_lat = Column(Float)
    dest_lng = Column(Float)
    origin_code = Column(String)
    dest_code = Column(String)